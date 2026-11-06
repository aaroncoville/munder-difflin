/**
 * The address the inbound Slack and webhook listeners bind. Their public route is
 * a tunnel that forwards to `localhost`, so loopback is enough unless the operator
 * is deliberately forwarding a LAN or router port. With that opt-in no host is
 * passed, so Node takes the operating system's wildcard: dual-stack where the
 * machine has IPv6, otherwise every IPv4 interface.
 *
 * Strictly `true`: the config file is hand-editable JSON, and a value such as the
 * string "false" must not expose the listener to the network.
 */
export function inboundListenHost(bindAllInterfaces: boolean | undefined): '127.0.0.1' | undefined {
  return bindAllInterfaces === true ? undefined : '127.0.0.1';
}
