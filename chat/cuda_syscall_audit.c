/* Diagnostic-only numeric observations. No policy exceptions or input logging.
 * Build together with loopback_ifaddrs.c at its fixed trusted library path.
 * These wrappers issue the original syscall; kernel denials remain authoritative.
 * Direct/inlined syscalls, ioctl and non-interposed symbols are NOT observed.
 * This is not a security boundary or a complete strace replacement.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

static _Atomic unsigned int records;

int qwen_cuda_audit_version(void) { return 1; }

static void record(const char *operation, long result, int saved_errno,
                   int family, int kind, int protocol) {
    int current_errno = errno;
    unsigned int n = atomic_fetch_add_explicit(&records, 1, memory_order_relaxed);
    if (n < 128) {
        char line[256];
        int size = snprintf(line, sizeof(line),
            "CUDA_SYSCALL {\"operation\":\"%s\",\"ok\":%s,\"errno\":%d,"
            "\"family\":%d,\"type\":%d,\"protocol\":%d}\n",
            operation, result < 0 ? "false" : "true", result < 0 ? saved_errno : 0,
            family, kind, protocol);
        if (size > 0 && (size_t)size < sizeof(line))
            (void)syscall(SYS_write, STDERR_FILENO, line, (size_t)size);
    } else if (n == 128) {
        static const char capped[] = "CUDA_SYSCALL {\"observations_capped\":true}\n";
        (void)syscall(SYS_write, STDERR_FILENO, capped, sizeof(capped) - 1);
    }
    errno = current_errno;
}

int socket(int family, int kind, int protocol) {
    int result = (int)syscall(SYS_socket, family, kind, protocol);
    int saved_errno = errno;
    record("socket", result, saved_errno, family, kind, protocol);
    errno = saved_errno;
    return result;
}

int socketpair(int family, int kind, int protocol, int pair[2]) {
    int result = (int)syscall(SYS_socketpair, family, kind, protocol, pair);
    int saved_errno = errno;
    record("socketpair", result, saved_errno, family, kind, protocol);
    errno = saved_errno;
    return result;
}

int connect(int fd, const struct sockaddr *address, socklen_t length) {
    int result = (int)syscall(SYS_connect, fd, address, length);
    int saved_errno = errno;
    /* Never inspect/log address bytes, path, target, fd, environment or payload. */
    record("connect", result, saved_errno, -1, -1, -1);
    errno = saved_errno;
    return result;
}

int memfd_create(const char *name, unsigned int flags) {
    int result = (int)syscall(SYS_memfd_create, name, flags);
    int saved_errno = errno;
    record("memfd_create", result, saved_errno, -1, -1, -1);
    errno = saved_errno;
    return result;
}
