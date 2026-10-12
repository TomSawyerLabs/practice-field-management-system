/** Represents an address on an interface */
export interface InterfaceAddress {
  family: 'inet' | 'inet6';
  address: string;
  prefixLength: number;
  broadcast?: string;
  scope?: string;
}

/** Represents the state of a network interface */
export interface InterfaceInfo {
  name: string;
  state: 'UP' | 'DOWN' | 'UNKNOWN' | string;
  mtu: number;
  mac?: string;
  addresses: InterfaceAddress[];
  link?: {
    kind?: string;
    parent?: string;
    vlanId?: number;
  };
}

/** Options for creating a VLAN sub-interface */
export interface VlanOptions {
  parent: string;
  vlanId: number;
  name: string;
}

/** Options for adding/removing an IP address */
export interface AddAddressOptions {
  interfaceName: string;
  address: string;
  prefixLength: number;
  broadcast?: string;
}

/** Options for sysctl settings */
export interface SysctlOptions {
  key: string;
  value: string;
}

/** Options for ARP-based duplicate address detection */
export interface ArpingOptions {
  interfaceName: string;
  address: string;
  /** Number of probes to send (default 2) */
  count?: number;
  /** Timeout in seconds (default 2) */
  timeout?: number;
}

/** Parsed iptables rule with packet/byte counters */
export interface ForwardCounter {
  comment: string;
  packets: number;
  bytes: number;
  inInterface?: string;
  outInterface?: string;
}

/** Options for IP policy routing rule management */
export interface IpRuleOptions {
  from: string;
  to?: string;
  table: number;
}

/** A parsed entry from `ip rule list` */
export interface IpRuleInfo {
  priority: number;
  /** Source address or "all" */
  src?: string;
  /** Destination CIDR or "all" */
  dst?: string;
  /** Routing table number or name (e.g. "main", "local") */
  table?: string;
}

/** Options for routing table entry management */
export interface RouteOptions {
  destination: string;
  device: string;
  table: number;
}

/** Options for iptables rule manipulation */
export interface IptablesOptions {
  action: '-A' | '-D' | '-I' | '-C';
  table?: string;
  chain: string;
  source?: string;
  destination?: string;
  notDestination?: string;
  inInterface?: string;
  outInterface?: string;
  /** Skip packets whose source is one of this host's own addresses
   *  (`-m addrtype ! --src-type LOCAL`): match forwarded traffic only. */
  notLocalSource?: boolean;
  protocol?: 'tcp' | 'udp';
  destinationPort?: number;
  jump: string;
  /** DNAT target address (e.g. "192.168.1.5:1150") — used with jump: 'DNAT' */
  toDestination?: string;
  comment?: string;
}
