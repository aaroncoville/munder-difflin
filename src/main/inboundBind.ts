/**
 * The address the inbound Slack and webhook listeners bind. Their public route is
 * a tunnel that forwards to `localhost`, so loopback is enough unless the operator
 * is deliberately forwarding a LAN or router port.
 *
 * Strictly `true`: the config file is hand-editable JSON, and a value such as the
 * string "false" must not expose the listener to the network.
 */
export function inboundListenHost(bindAllInterfaces: boolean | undefined): '127.0.0.1' | '0.0.0.0' {
  return bindAllInterfaces === true ? '0.0.0.0' : '127.0.0.1';
}
