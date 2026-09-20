#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

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
static void isolate_reads(const char *root, const char *dynamic_root, char **secret_paths,
                          int secret_count, int isolate_writes) {
  const __u64 rights = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |
                         LANDLOCK_ACCESS_FS_READ_DIR;
  const __u64 write_rights = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
      LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
      LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER |
      LANDLOCK_ACCESS_FS_TRUNCATE;
  if (isolate_writes) {
    int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
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
    if (abi < 1) fail("Landlock is unavailable");
    /* This process is disposable: apply the real policy too, so an ABI that is
       reported but unusable under the host's LSM/container settings fails the
       Runner startup probe rather than the first approved command. */
    isolate_reads("/usr", NULL, NULL, 0, 0);
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
