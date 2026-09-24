#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <linux/landlock.h>
#include <limits.h>
#include <mntent.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

static void fail(const char *message) {
  fprintf(stderr, "verity-script-sandbox: %s: %s\n", message, strerror(errno));
  exit(126);
}
static void allow_path(int ruleset, const char *path, __u64 rights) {
  int parent = open(path, O_PATH | O_CLOEXEC);
  if (parent < 0) fail(path);
  struct landlock_path_beneath_attr rule = {.allowed_access = rights, .parent_fd = parent};
  if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0)
    fail("landlock_add_rule");
  close(parent);
}

static void write_mapping(const char *path, unsigned int inside, unsigned int outside) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) fail(path);
  char mapping[64];
  int length = snprintf(mapping, sizeof(mapping), "%u %u 1\n", inside, outside);
  if (length < 0 || write(fd, mapping, (size_t)length) != length) fail(path);
  close(fd);
}

static void make_parents(const char *path) {
  char copy[PATH_MAX];
  if (strlen(path) >= sizeof(copy)) { errno = ENAMETOOLONG; fail(path); }
  strcpy(copy, path);
  for (char *cursor = copy + 1; *cursor != '\0'; cursor++) {
    if (*cursor != '/') continue;
    *cursor = '\0';
    if (mkdir(copy, 0700) < 0 && errno != EEXIST) fail(copy);
    *cursor = '/';
  }
}

static int path_is_beneath(const char *path, const char *root) {
  size_t length = strlen(root);
  return !strncmp(path, root, length) && (path[length] == '\0' || path[length] == '/');
}

static void make_read_only_recursive(const char *target) {
  FILE *mounts = setmntent("/proc/self/mounts", "r");
  if (mounts == NULL) fail("read mount table");
  struct mntent *entry;
  while ((entry = getmntent(mounts)) != NULL) {
    if (!path_is_beneath(entry->mnt_dir, target)) continue;
    if (mount(NULL, entry->mnt_dir, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL) < 0)
      fail("read-only bind mount");
  }
  endmntent(mounts);
}

static void bind_into(const char *sandbox, const char *source, int writable) {
  struct stat metadata;
  if (stat(source, &metadata) < 0) fail(source);
  char target[PATH_MAX];
  if (snprintf(target, sizeof(target), "%s%s", sandbox, source) >= (int)sizeof(target)) {
    errno = ENAMETOOLONG;
    fail(source);
  }
  make_parents(target);
  if (S_ISDIR(metadata.st_mode)) {
    if (mkdir(target, 0700) < 0 && errno != EEXIST) fail(target);
  } else {
    int fd = open(target, O_CREAT | O_WRONLY | O_CLOEXEC, 0600);
    if (fd < 0) fail(target);
    close(fd);
  }
  if (mount(source, target, NULL, MS_BIND | (S_ISDIR(metadata.st_mode) ? MS_REC : 0), NULL) < 0)
    fail(source);
  if (!writable) make_read_only_recursive(target);
}

static void symlink_into(const char *sandbox, const char *target, const char *link_path) {
  char path[PATH_MAX];
  if (snprintf(path, sizeof(path), "%s%s", sandbox, link_path) >= (int)sizeof(path)) {
    errno = ENAMETOOLONG;
    fail(link_path);
  }
  make_parents(path);
  if (symlink(target, path) < 0) fail(link_path);
}

static void drop_namespace_privileges(void) {
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("PR_SET_NO_NEW_PRIVS");
  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3,
      .pid = 0,
  };
  struct __user_cap_data_struct capabilities[2] = {{0}, {0}};
  if (syscall(SYS_capset, &header, capabilities) < 0) fail("drop namespace capabilities");
}

static volatile sig_atomic_t sandbox_child = -1;

static void stop_sandbox_child(int signal_number) {
  (void)signal_number;
  if (sandbox_child > 0) kill((pid_t)sandbox_child, SIGKILL);
}

static void enter_pid_namespace(void) {
  if (unshare(CLONE_NEWPID) < 0) fail("unshare pid namespace");
  pid_t child = fork();
  if (child < 0) fail("enter pid namespace");
  if (child == 0) {
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0) fail("bind sandbox lifetime");
    return;
  }

  sandbox_child = child;
  struct sigaction action = {.sa_handler = stop_sandbox_child};
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) < 0 || sigaction(SIGINT, &action, NULL) < 0 ||
      sigaction(SIGHUP, &action, NULL) < 0)
    fail("install sandbox signal handler");
  int status;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) fail("wait for sandbox child");
  }
  if (WIFEXITED(status)) exit(WEXITSTATUS(status));
  if (WIFSIGNALED(status)) exit(128 + WTERMSIG(status));
  exit(126);
}

/* gVisor does not implement Landlock, but does implement unprivileged user and
   mount namespaces. Build a new root containing only the paths the Landlock
   policy allows, then chroot into it. The namespace root maps to the caller's
   uid outside, so it gains mount/chroot capability without gaining host or
   container privilege. */
static void isolate_with_mounts(const char *root, const char *dynamic_root, char **secret_paths,
                                int secret_count, int isolate_writes) {
  uid_t uid = getuid();
  gid_t gid = getgid();
  char sandbox[] = "/tmp/verity-script-sandbox-XXXXXX";
  if (mkdtemp(sandbox) == NULL) fail("create sandbox root");
  int cleanup[2];
  if (pipe2(cleanup, O_CLOEXEC) < 0) fail("create sandbox cleanup pipe");
  pid_t cleaner = fork();
  if (cleaner < 0) fail("start sandbox cleanup");
  if (cleaner == 0) {
    close(cleanup[1]);
    char ready;
    while (read(cleanup[0], &ready, 1) < 0 && errno == EINTR) {}
    close(cleanup[0]);
    rmdir(sandbox);
    _exit(0);
  }
  close(cleanup[0]);

  if (unshare(CLONE_NEWUSER) < 0) fail("unshare user namespace");
  int setgroups = open("/proc/self/setgroups", O_WRONLY | O_CLOEXEC);
  if (setgroups >= 0) {
    if (write(setgroups, "deny\n", 5) != 5) fail("disable setgroups");
    close(setgroups);
  }
  write_mapping("/proc/self/uid_map", 0, (unsigned int)uid);
  write_mapping("/proc/self/gid_map", 0, (unsigned int)gid);
  if (setresgid(0, 0, 0) < 0 || setresuid(0, 0, 0) < 0) fail("enter user namespace");
  if (unshare(CLONE_NEWNS) < 0) fail("unshare mount namespace");
  enter_pid_namespace();
  if (mount("tmpfs", sandbox, "tmpfs", MS_NOSUID | MS_NODEV, "mode=0700,size=16m") < 0)
    fail("mount sandbox root");

  /* A whole-/usr bind is rejected by runsc. Its stable runtime subtrees are
     separate mounts so interpreters, shared libraries and locale/CA data work. */
  const char *runtime_dirs[] = {
      "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib64", "/usr/local", "/usr/share",
      "/bin", "/sbin", "/lib", "/lib64", "/etc/alternatives", "/etc/ssl/certs"};
  for (size_t i = 0; i < sizeof(runtime_dirs) / sizeof(runtime_dirs[0]); i++)
    if (access(runtime_dirs[i], F_OK) == 0) bind_into(sandbox, runtime_dirs[i], 0);
  const char *runtime_files[] = {
      "/etc/ld.so.cache", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf",
      "/etc/gai.conf", "/etc/host.conf", "/etc/localtime"};
  for (size_t i = 0; i < sizeof(runtime_files) / sizeof(runtime_files[0]); i++)
    if (access(runtime_files[i], F_OK) == 0) bind_into(sandbox, runtime_files[i], 0);
  const char *devices[] = {"/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/tty"};
  for (size_t i = 0; i < sizeof(devices) / sizeof(devices[0]); i++)
    if (access(devices[i], F_OK) == 0) bind_into(sandbox, devices[i], 1);
  char proc[PATH_MAX];
  if (snprintf(proc, sizeof(proc), "%s/proc", sandbox) >= (int)sizeof(proc)) {
    errno = ENAMETOOLONG;
    fail("proc mount path");
  }
  if (mkdir(proc, 0555) < 0) fail("create proc mount");
  if (mount("proc", proc, "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) < 0)
    fail("mount proc");
  symlink_into(sandbox, "/proc/self/fd", "/dev/fd");

  bind_into(sandbox, root, !isolate_writes);
  if (dynamic_root != NULL) bind_into(sandbox, dynamic_root, !isolate_writes);
  for (int i = 0; i < secret_count; i++) bind_into(sandbox, secret_paths[i * 2], 0);
  if (chroot(sandbox) < 0) fail("chroot");
  if (chdir("/") < 0) fail("chdir sandbox root");
  if (write(cleanup[1], "x", 1) != 1) fail("clean sandbox root");
  close(cleanup[1]);
  drop_namespace_privileges();
}

static void isolate_reads(const char *root, const char *dynamic_root, char **secret_paths,
                          int secret_count, int isolate_writes) {
  const __u64 rights = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |
                         LANDLOCK_ACCESS_FS_READ_DIR;
  const __u64 write_rights = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
      LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
      LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER |
      LANDLOCK_ACCESS_FS_TRUNCATE;
  int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  const char *force_mount_namespace = getenv("VERITY_SCRIPT_SANDBOX_FORCE_MOUNT_NAMESPACE");
  if ((abi < 0 && errno == ENOSYS) ||
      (force_mount_namespace != NULL && !strcmp(force_mount_namespace, "1"))) {
    isolate_with_mounts(root, dynamic_root, secret_paths, secret_count, isolate_writes);
    return;
  }
  if (isolate_writes) {
    if (abi < 3) { errno = ENOTSUP; fail("Wiki isolation requires Landlock ABI 3"); }
  }
  struct landlock_ruleset_attr attr = {.handled_access_fs = rights | (isolate_writes ? write_rights : 0)};
  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (ruleset < 0) fail("landlock_create_ruleset");
  const char *roots[] = {"/usr", "/bin", "/lib", "/lib64"};
  for (size_t i = 0; i < sizeof(roots) / sizeof(roots[0]); i++)
    if (access(roots[i], F_OK) == 0) allow_path(ruleset, roots[i], rights);
  /* Runtime discovery without exposing arbitrary host/container configuration
     such as /etc/shadow, service credentials or application config. */
  const char *runtime_files[] = {
      "/etc/ld.so.cache", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf",
      "/etc/gai.conf", "/etc/host.conf", "/etc/localtime"};
  for (size_t i = 0; i < sizeof(runtime_files) / sizeof(runtime_files[0]); i++)
    if (access(runtime_files[i], F_OK) == 0)
      allow_path(ruleset, runtime_files[i], LANDLOCK_ACCESS_FS_READ_FILE);
  const char *runtime_dirs[] = {"/etc/ssl/certs"};
  for (size_t i = 0; i < sizeof(runtime_dirs) / sizeof(runtime_dirs[0]); i++)
    if (access(runtime_dirs[i], F_OK) == 0) allow_path(ruleset, runtime_dirs[i], rights);
  const char *devices[] = {"/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/tty"};
  for (size_t i = 0; i < sizeof(devices) / sizeof(devices[0]); i++)
    if (access(devices[i], F_OK) == 0)
      allow_path(ruleset, devices[i], LANDLOCK_ACCESS_FS_READ_FILE | (isolate_writes ? LANDLOCK_ACCESS_FS_WRITE_FILE : 0));
  allow_path(ruleset, root, rights | (isolate_writes ? write_rights : 0));
  if (dynamic_root != NULL) allow_path(ruleset, dynamic_root, rights | (isolate_writes ? write_rights : 0));
  for (int i = 0; i < secret_count; i++)
    allow_path(ruleset, secret_paths[i * 2], LANDLOCK_ACCESS_FS_READ_FILE);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("PR_SET_NO_NEW_PRIVS");
  if (syscall(SYS_landlock_restrict_self, ruleset, 0) < 0) fail("landlock_restrict_self");
  close(ruleset);
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--probe")) {
    int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 1 && errno != ENOSYS) fail("script isolation is unavailable");
    /* This process is disposable: apply the real policy too, so an ABI that is
       reported but unusable under the host's LSM/container settings fails the
       Runner startup probe rather than the first approved command. */
    isolate_reads("/usr/bin", NULL, NULL, 0, 0);
    return 0;
  }
  if (argc < 9 || strcmp(argv[1], "--root") || strcmp(argv[3], "--cwd") ||
      strcmp(argv[5], "--loading")) {
    fputs("usage: verity-script-sandbox --root PATH --cwd PATH --loading isolated|dynamic [--dynamic-root PATH] [--write-isolated] [--secret PATH] -- COMMAND\n",
          stderr);
    return 126;
  }
  if (argv[2][0] != '/' || argv[4][0] != '/' ||
      (strcmp(argv[6], "isolated") && strcmp(argv[6], "dynamic"))) {
    errno = EINVAL;
    fail("invalid argument");
  }
  int command = 7;
  const char *dynamic_root = NULL;
  if (command + 1 < argc && !strcmp(argv[command], "--dynamic-root")) {
    if (strcmp(argv[6], "dynamic") || argv[command + 1][0] != '/') {
      errno = EINVAL;
      fail("invalid dynamic root");
    }
    dynamic_root = argv[command + 1];
    command += 2;
  }
  int isolate_writes = 0;
  if (command < argc && !strcmp(argv[command], "--write-isolated")) {
    isolate_writes = 1;
    command++;
  }
  int secret_start = command;
  while (command + 1 < argc && !strcmp(argv[command], "--secret")) {
    if (argv[command + 1][0] != '/') { errno = EINVAL; fail("invalid secret path"); }
    command += 2;
  }
  if (command >= argc || strcmp(argv[command], "--") || command + 1 >= argc) {
    errno = EINVAL;
    fail("invalid command");
  }
  if (!strcmp(argv[6], "dynamic") && dynamic_root == NULL) {
    errno = EINVAL;
    fail("missing dynamic root");
  }
  isolate_reads(argv[2], dynamic_root, &argv[secret_start + 1], (command - secret_start) / 2, isolate_writes);
  if (chdir(argv[4]) < 0) fail("chdir");
  execv(argv[command + 1], &argv[command + 1]);
  fail("execv");
}
