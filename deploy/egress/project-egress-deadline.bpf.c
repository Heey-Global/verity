// SPDX-License-Identifier: GPL-2.0-only
/* Host-owned TC guard. nftables remains responsible for destination authority.
 * An absent/zero deadline denies, even if a delayed controller commits later.
 * Both TC ingress and egress must attach the same pinned program/map instance.
 */
#ifdef VERITY_RELAY_PACKET_TEST
typedef __UINT8_TYPE__ __u8;
typedef __UINT32_TYPE__ __u32;
typedef __UINT64_TYPE__ __u64;
#else
#include <linux/bpf.h>
#include <linux/pkt_cls.h>
#endif

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
/* Disabled unless the trusted host has installed an exact inspected pair.
 * nftables must still authorize its interface/MAC pair and conntrack label.
 */
struct relay_policy {
    __u32 enabled;
    __u32 codex;
    __u8 sandbox_ip[4];
    __u8 relay_ip[4];
    __u8 sandbox_mac[6];
    __u8 relay_mac[6];
};
#ifndef VERITY_RELAY_PACKET_TEST
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct relay_policy);
} relay_transport SEC(".maps");
#endif

static __inline __attribute__((always_inline))
int same_bytes(const __u8 *a, const __u8 *b, int count)
{
#pragma unroll
    for (int i = 0; i < 6; i++) {
        if (i < count && a[i] != b[i])
            return 0;
    }
    return 1;
}

/* Recognize only the existing IPv4 relay services and their exact ARP pair.
 * VLANs, IP options, fragments, IPv6, UDP and arbitrary service ports receive
 * no system exception. This classifier never grants an Internet destination.
 */
static __inline __attribute__((always_inline))
int relay_packet_matches(const __u8 *data, __u32 length,
                         const struct relay_policy *policy)
{
    if (!policy || policy->enabled != 1 || policy->codex > 1 || length < 14 ||
        (policy->sandbox_mac[0] & 1) || (policy->relay_mac[0] & 1) ||
        same_bytes(policy->sandbox_ip, policy->relay_ip, 4) ||
        same_bytes(policy->sandbox_mac, policy->relay_mac, 6))
        return 0;
    int arp = data[12] == 0x08 && data[13] == 0x06;
    if (arp) {
        if (length < 42 || data[14] != 0 || data[15] != 1 ||
            data[16] != 0x08 || data[17] != 0 || data[18] != 6 || data[19] != 4 ||
            data[20] != 0 || (data[21] != 1 && data[21] != 2))
            return 0;
    } else if (length < 54 || data[12] != 0x08 || data[13] != 0 ||
               data[14] != 0x45 || data[23] != 6 ||
               (data[20] & 0xbf) != 0 || data[21] != 0 ||
               ((__u32)data[16] * 256 + data[17]) < 40 || (data[46] >> 4) < 5) {
        return 0;
    }
    if (!arp) {
        __u32 ip_length = (__u32)data[16] * 256 + data[17];
        __u32 tcp_length = (__u32)(data[46] >> 4) * 4;
        if (ip_length > length - 14 || 20 + tcp_length > ip_length)
            return 0;
    }
    const __u8 *source_ip = data + (arp ? 28 : 26);
    const __u8 *target_ip = data + (arp ? 38 : 30);
    int reverse = same_bytes(source_ip, policy->relay_ip, 4) &&
                  same_bytes(target_ip, policy->sandbox_ip, 4);
    if (!reverse && !(same_bytes(source_ip, policy->sandbox_ip, 4) &&
                      same_bytes(target_ip, policy->relay_ip, 4)))
        return 0;
    const __u8 *source_mac = reverse ? policy->relay_mac : policy->sandbox_mac;
    const __u8 *target_mac = reverse ? policy->sandbox_mac : policy->relay_mac;
    if (!same_bytes(data + 6, source_mac, 6))
        return 0;
    if (arp) {
        const __u8 broadcast[6] = {255, 255, 255, 255, 255, 255};
        const __u8 zero[6] = {0, 0, 0, 0, 0, 0};
        if (!same_bytes(data + 22, source_mac, 6) ||
            (!same_bytes(data, target_mac, 6) &&
             !(data[21] == 1 && same_bytes(data, broadcast, 6))) ||
            (!same_bytes(data + 32, target_mac, 6) &&
             !(data[21] == 1 && same_bytes(data + 32, zero, 6))))
            return 0;
        return 1;
    }
    if (!same_bytes(data, target_mac, 6))
        return 0;
    int offset = reverse ? 34 : 36;
    __u32 port = (__u32)data[offset] * 256 + data[offset + 1];
    return port == 8080 || port == 8443 || (policy->codex == 1 && port == 8444);
}
#ifndef VERITY_RELAY_PACKET_TEST
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
struct relay_observation {
    __u64 accepted;
    __u64 last_accepted_boot_ns;
};
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, struct relay_observation);
} relay_observations SEC(".maps");

static void *(*lookup)(void *, const void *) = (void *)BPF_FUNC_map_lookup_elem;
static __u64 (*boot_ns)(void) = (void *)BPF_FUNC_ktime_get_boot_ns;
static long (*load_bytes)(const struct __sk_buff *, __u32, void *, __u32) =
    (void *)BPF_FUNC_skb_load_bytes;

SEC("classifier")
int enforce_deadline(struct __sk_buff *skb)
{
    __u32 key = 0;
    struct lease *current = lookup(&deadline, &key);
    struct observation *seen = lookup(&observations, &key);
    __u64 observed = boot_ns();
    int allowed = 0;
    if (current && current->ifindex == skb->ifindex && current->reserved == 0) {
        int system = 0;
        struct relay_policy *policy = lookup(&relay_transport, &key);
        if (policy && policy->enabled == 1) {
            __u8 data[54] = {0};
            if (load_bytes(skb, 0, data, 14) == 0) {
                __u32 length = data[12] == 0x08 && data[13] == 0x06 ? 42 : 54;
                if (load_bytes(skb, 0, data, length) == 0)
                    system = relay_packet_matches(data, skb->len, policy);
            }
        }
        if (system) {
            struct relay_observation *relay_seen = lookup(&relay_observations, &key);
            if (relay_seen) {
                relay_seen->accepted++;
                relay_seen->last_accepted_boot_ns = observed;
            }
            return TC_ACT_OK;
        }
        allowed = current->boot_deadline_ns != 0 && observed < current->boot_deadline_ns;
    }
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
#endif
