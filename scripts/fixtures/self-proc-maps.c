#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 10;
  int landlock = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) >= 1;
  int fd = open("/proc/self/maps", O_RDONLY | O_CLOEXEC);
  char data[64];
  if (fd < 0 || read(fd, data, sizeof(data)) <= 0) return 11;
  close(fd);
  if (landlock) {
    if (open("/proc/self/environ", O_RDONLY) >= 0) return 12;
    if (open("/proc/self/maps", O_WRONLY) >= 0) return 13;
    char peer[64];
    snprintf(peer, sizeof(peer), "/proc/%d/maps", getppid());
    if (open(peer, O_RDONLY) >= 0) return 14;
  }
  if (open(argv[1], O_WRONLY | O_TRUNC) >= 0) return 15;
  fd = open(argv[2], O_WRONLY | O_CREAT, 0600);
  if (fd < 0 || write(fd, "runtime", 7) != 7) return 16;
  close(fd);
  pid_t child = fork();
  if (child < 0) return 17;
  if (child == 0) {
    execl("/bin/sh", "sh", "-c", "cat /proc/self/maps >/dev/null", NULL);
    _exit(18);
  }
  int status;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) return 19;
  puts(landlock ? "landlock: self maps and descendant verified" : "namespace: private procfs verified");
  return 0;
}
