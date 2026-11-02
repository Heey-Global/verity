// SPDX-License-Identifier: GPL-2.0-only
/* Host-only test-run program, never attached to a network interface. Renew an
 * unchanged authorization epoch only while its previous kernel lease is live.
 * Userspace cannot prove this across a delayed map update with a clock precheck.
 */
#ifdef VERITY_DEADLINE_RENEW_TEST
typedef __UINT8_TYPE__ __u8;
typedef __UINT32_TYPE__ __u32;
typedef __UINT64_TYPE__ __u64;
#define BPF_MAP_TYPE_ARRAY 2
#define BPF_ANY 0
struct __sk_buff { __u32 len; __u8 payload[24]; };
#else
#include <linux/bpf.h>
#endif
#define SEC(name) __attribute__((section(name), used))
#define __uint(name, value) int (*name)[value]
#define __type(name, value) value *name
struct lease { __u64 deadline; __u32 ifindex; __u32 reserved; };
struct request { __u64 previous; __u64 next; __u32 ifindex; __u32 reserved; };
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct lease);
} deadline SEC(".maps");
#ifndef VERITY_DEADLINE_RENEW_TEST
static void *(*lookup)(void *, const void *) = (void *)BPF_FUNC_map_lookup_elem;
static long (*update)(void *, const void *, const void *, __u64) = (void *)BPF_FUNC_map_update_elem;
static __u64 (*boot_ns)(void) = (void *)BPF_FUNC_ktime_get_boot_ns;
static long (*load_bytes)(const struct __sk_buff *, __u32, void *, __u32) = (void *)BPF_FUNC_skb_load_bytes;
#else
#define lookup test_lookup
#define update test_update
#define boot_ns test_boot
#define load_bytes test_load
#endif
SEC("socket")
int renew_deadline(struct __sk_buff *skb)
{
    struct request proposed = {0};
    __u32 key = 0;
    if (skb->len < sizeof(proposed) || load_bytes(skb, skb->len - sizeof(proposed), &proposed, sizeof(proposed)) != 0 || proposed.reserved != 0)
        return 0;
    struct lease *current = lookup(&deadline, &key);
    if (!current || current->reserved != 0 || current->ifindex != proposed.ifindex ||
        current->deadline != proposed.previous || proposed.next <= proposed.previous)
        return 0;
    __u64 observed = boot_ns();
    if (observed >= proposed.previous || proposed.next <= observed ||
        proposed.next - observed > 1000000000ULL)
        return 0;
    struct lease next = {proposed.next, proposed.ifindex, 0};
    return update(&deadline, &key, &next, BPF_ANY) == 0 ? 1 : 0;
}
char _license[] SEC("license") = "GPL";
