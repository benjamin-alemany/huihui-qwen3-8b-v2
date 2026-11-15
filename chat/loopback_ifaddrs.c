/* Compatibility only, NOT an access-control boundary.
 * Pinned single-GPU Gloo/NCCL may enumerate interfaces using NETLINK_ROUTE.
 * Report only static IPv4 loopback instead, without opening any socket.
 * Kernel socket/connect/egress denials remain unchanged and authoritative.
 * No constructors, environment access, files, network I/O or model inputs.
 */
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <errno.h>

struct loopback_entry {
    struct ifaddrs entry;
    struct sockaddr_in address;
    struct sockaddr_in mask;
    char name[3];
};

int getifaddrs(struct ifaddrs **result) {
    if (result == NULL) { errno = EINVAL; return -1; }
    *result = NULL;
    struct loopback_entry *node = calloc(1, sizeof(*node));
    if (node == NULL) { return -1; }
    node->name[0] = 'l'; node->name[1] = 'o';
    node->entry.ifa_name = node->name;
    node->entry.ifa_flags = IFF_UP | IFF_RUNNING | IFF_LOOPBACK;
    node->address.sin_family = AF_INET;
    node->address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    node->mask.sin_family = AF_INET;
    node->mask.sin_addr.s_addr = htonl(0xff000000U);
    node->entry.ifa_addr = (struct sockaddr *)&node->address;
    node->entry.ifa_netmask = (struct sockaddr *)&node->mask;
    *result = &node->entry;
    return 0;
}

void freeifaddrs(struct ifaddrs *entry) {
    free(entry); /* entry is the first member of loopback_entry. */
}
