/* CPU fixture ONLY. Deterministic CUDA-304 analogue, never in GPU image. */
#define _GNU_SOURCE
#include <errno.h>
#include <sys/socket.h>
#include <unistd.h>
int cuDriverGetVersion(int *version) { *version = 13000; return 0; }
int cuInit(unsigned int flags) {
    if (flags != 0) return 1;
    int fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (fd < 0) return errno == EPERM ? 304 : 999;
    close(fd);
    return 0;
}
int cuDeviceGetCount(int *count) { *count = 1; return 0; }
