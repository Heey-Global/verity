// SPDX-License-Identifier: GPL-2.0-only
/* Host-owned TC guard. nftables remains responsible for destination authority.
 * An absent/zero deadline denies, even if a delayed controller commits later.
 * Both TC ingress and egress must attach the same pinned program/map instance.
 */
#include <linux/bpf.h>
#include <linux/pkt_cls.h>

#define SEC(name) __attribute__((section(name), used))
#define __uint(name, value) int (*name)[value]
#define __type(name, value) value *name

struct lease {
    __u64 boot_deadline_ns;
    __u32 ifindex;
    __u32 reserved;
};
struct observation {
    __u64 accepted;
    __u64 denied;
    __u64 last_accepted_boot_ns;
    __u64 last_denied_boot_ns;
};
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct lease);
} deadline SEC(".maps");
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct observation);
} observations SEC(".maps");

static void *(*lookup)(void *, const void *) = (void *)BPF_FUNC_map_lookup_elem;
static __u64 (*boot_ns)(void) = (void *)BPF_FUNC_ktime_get_boot_ns;

SEC("classifier")
int enforce_deadline(struct __sk_buff *skb)
{
    __u32 key = 0;
    struct lease *current = lookup(&deadline, &key);
    struct observation *seen = lookup(&observations, &key);
    __u64 observed = boot_ns();
    int allowed = current && current->ifindex == skb->ifindex &&
                  current->reserved == 0 && current->boot_deadline_ns != 0 &&
                  observed < current->boot_deadline_ns;
    if (seen) {
        if (allowed) {
            seen->accepted++;
            seen->last_accepted_boot_ns = observed;
        } else {
            seen->denied++;
            seen->last_denied_boot_ns = observed;
        }
    }
    return allowed ? TC_ACT_OK : TC_ACT_SHOT;
}
char _license[] SEC("license") = "GPL";
