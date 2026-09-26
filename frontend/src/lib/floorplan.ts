// Hypothetical shop-floor layout for the Airframe captures (positions invented, AP numbering and
// device-to-AP assignment taken from the captures). Coordinates are in the 1376 x 768 space of
// components/hall-scene.tsx.
import type { SiteLayout } from "@/lib/api";

export const FLOOR = { width: 1376, height: 768 } as const;

// `cell` is the grid slot: row A (top) to E, column 1 to 6
export type FloorAp = {
  num: string;
  cell: string;
  x: number;
  y: number;
  corp: string;
  tools: string;
  channel: number | null;
};
// device drawn at its AP's position plus (dx, dy); `name` without location, see deviceLabel()
export type FloorDeviceSpec = {
  mac: string;
  kind: "tool" | "laptop" | "phone";
  name: string;
  network: string;
  ap: string;
  dx: number;
  dy: number;
};
export type FloorDevice = FloorDeviceSpec & { x: number; y: number; cell: string };

export const FLOOR_APS: FloorAp[] = [
  {"num": "01", "cell": "A1", "x": 147.9, "y": 208.0, "corp": "00:0b:86:01:00:00", "tools": "00:0b:86:01:00:01", "channel": 36},
  {"num": "02", "cell": "A2", "x": 363.8, "y": 208.0, "corp": "00:0b:86:02:00:00", "tools": "00:0b:86:02:00:01", "channel": 36},
  {"num": "03", "cell": "A3", "x": 579.6, "y": 208.0, "corp": "00:0b:86:03:00:00", "tools": "00:0b:86:03:00:01", "channel": 40},
  {"num": "04", "cell": "A4", "x": 795.4, "y": 208.0, "corp": "00:0b:86:04:00:00", "tools": "00:0b:86:04:00:01", "channel": 44},
  {"num": "05", "cell": "A5", "x": 1011.2, "y": 208.0, "corp": "00:0b:86:05:00:00", "tools": "00:0b:86:05:00:01", "channel": 48},
  {"num": "06", "cell": "A6", "x": 1227.1, "y": 208.0, "corp": "00:0b:86:06:00:00", "tools": "00:0b:86:06:00:01", "channel": 149},
  {"num": "07", "cell": "B1", "x": 147.9, "y": 324.0, "corp": "00:0b:86:07:00:00", "tools": "00:0b:86:07:00:01", "channel": 153},
  {"num": "08", "cell": "B2", "x": 363.8, "y": 324.0, "corp": "00:0b:86:08:00:00", "tools": "00:0b:86:08:00:01", "channel": 157},
  {"num": "09", "cell": "B3", "x": 579.6, "y": 324.0, "corp": "00:0b:86:09:00:00", "tools": "00:0b:86:09:00:01", "channel": 161},
  {"num": "0a", "cell": "B4", "x": 795.4, "y": 324.0, "corp": "00:0b:86:0a:00:00", "tools": "00:0b:86:0a:00:01", "channel": 36},
  {"num": "0b", "cell": "B5", "x": 1011.2, "y": 324.0, "corp": "00:0b:86:0b:00:00", "tools": "00:0b:86:0b:00:01", "channel": 40},
  {"num": "0c", "cell": "B6", "x": 1227.1, "y": 324.0, "corp": "00:0b:86:0c:00:00", "tools": "00:0b:86:0c:00:01", "channel": 44},
  {"num": "0d", "cell": "C1", "x": 147.9, "y": 440.0, "corp": "00:0b:86:0d:00:00", "tools": "00:0b:86:0d:00:01", "channel": null},
  {"num": "0e", "cell": "C2", "x": 363.8, "y": 440.0, "corp": "00:0b:86:0e:00:00", "tools": "00:0b:86:0e:00:01", "channel": 149},
  {"num": "0f", "cell": "C3", "x": 579.6, "y": 440.0, "corp": "00:0b:86:0f:00:00", "tools": "00:0b:86:0f:00:01", "channel": 149},
  {"num": "10", "cell": "C4", "x": 795.4, "y": 440.0, "corp": "00:0b:86:10:00:00", "tools": "00:0b:86:10:00:01", "channel": 153},
  {"num": "11", "cell": "C5", "x": 1011.2, "y": 440.0, "corp": "00:0b:86:11:00:00", "tools": "00:0b:86:11:00:01", "channel": 157},
  {"num": "12", "cell": "C6", "x": 1227.1, "y": 440.0, "corp": "00:0b:86:12:00:00", "tools": "00:0b:86:12:00:01", "channel": 161},
  {"num": "13", "cell": "D1", "x": 147.9, "y": 556.0, "corp": "00:0b:86:13:00:00", "tools": "00:0b:86:13:00:01", "channel": 36},
  {"num": "14", "cell": "D2", "x": 363.8, "y": 556.0, "corp": "00:0b:86:14:00:00", "tools": "00:0b:86:14:00:01", "channel": 40},
  {"num": "15", "cell": "D3", "x": 579.6, "y": 556.0, "corp": "00:0b:86:15:00:00", "tools": "00:0b:86:15:00:01", "channel": 44},
  {"num": "16", "cell": "D4", "x": 795.4, "y": 556.0, "corp": "00:0b:86:16:00:00", "tools": "00:0b:86:16:00:01", "channel": 48},
  {"num": "17", "cell": "D5", "x": 1011.2, "y": 556.0, "corp": "00:0b:86:17:00:00", "tools": "00:0b:86:17:00:01", "channel": 48},
  {"num": "18", "cell": "D6", "x": 1227.1, "y": 556.0, "corp": "00:0b:86:18:00:00", "tools": "00:0b:86:18:00:01", "channel": 149},
  {"num": "19", "cell": "E1", "x": 147.9, "y": 672.0, "corp": "00:0b:86:19:00:00", "tools": "00:0b:86:19:00:01", "channel": 153},
  {"num": "1a", "cell": "E2", "x": 363.8, "y": 672.0, "corp": "00:0b:86:1a:00:00", "tools": "00:0b:86:1a:00:01", "channel": 157},
  {"num": "1b", "cell": "E3", "x": 579.6, "y": 672.0, "corp": "00:0b:86:1b:00:00", "tools": "00:0b:86:1b:00:01", "channel": 161},
  {"num": "1c", "cell": "E4", "x": 795.4, "y": 672.0, "corp": "00:0b:86:1c:00:00", "tools": "00:0b:86:1c:00:01", "channel": 36},
  {"num": "1d", "cell": "E5", "x": 1011.2, "y": 672.0, "corp": "00:0b:86:1d:00:00", "tools": "00:0b:86:1d:00:01", "channel": 40},
  {"num": "1e", "cell": "E6", "x": 1227.1, "y": 672.0, "corp": "00:0b:86:1e:00:00", "tools": "00:0b:86:1e:00:01", "channel": 40},
];

export const FLOOR_DEVICE_SPECS: FloorDeviceSpec[] = [
  {"mac": "3c:58:c2:00:00:01", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "01", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:02", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "02", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:03", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "03", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:04", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "04", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:05", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "05", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:06", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "06", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:07", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "07", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:08", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "08", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:09", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "09", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:0a", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "0a", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:0b", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "0b", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:0c", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "0c", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:0d", "kind": "laptop", "name": "Logistics PC", "network": "TESLA-CORP", "ap": "0d", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:0e", "kind": "laptop", "name": "Logistics PC", "network": "TESLA-CORP", "ap": "0e", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:0f", "kind": "laptop", "name": "Logistics PC", "network": "TESLA-CORP", "ap": "0f", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:10", "kind": "laptop", "name": "Logistics PC", "network": "TESLA-CORP", "ap": "10", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:11", "kind": "laptop", "name": "Logistics PC", "network": "TESLA-CORP", "ap": "11", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:12", "kind": "laptop", "name": "Logistics PC", "network": "TESLA-CORP", "ap": "12", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:13", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "13", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:14", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "14", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:15", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "15", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:16", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "16", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:17", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "17", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:18", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "18", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:19", "kind": "laptop", "name": "Office laptop", "network": "TESLA-CORP", "ap": "19", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:1a", "kind": "laptop", "name": "Office laptop", "network": "TESLA-CORP", "ap": "1a", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:1b", "kind": "laptop", "name": "Laptop", "network": "TESLA-CORP", "ap": "1b", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:1c", "kind": "laptop", "name": "Laptop", "network": "TESLA-CORP", "ap": "1c", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:1d", "kind": "laptop", "name": "Maintenance laptop", "network": "TESLA-CORP", "ap": "1d", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:1e", "kind": "laptop", "name": "Maintenance laptop", "network": "TESLA-CORP", "ap": "1e", "dx": 30.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:1f", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "01", "dx": 46.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:20", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "02", "dx": 46.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:21", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "03", "dx": 46.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:22", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "04", "dx": 46.0, "dy": 40.0},
  {"mac": "3c:58:c2:00:00:23", "kind": "laptop", "name": "Line PC", "network": "TESLA-CORP", "ap": "05", "dx": 46.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:01", "kind": "tool", "name": "Hand scanner", "network": "TESLA-TOOLS", "ap": "0d", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:02", "kind": "tool", "name": "Hand scanner", "network": "TESLA-TOOLS", "ap": "0e", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:03", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "0f", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:04", "kind": "tool", "name": "Hand scanner", "network": "TESLA-TOOLS", "ap": "10", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:05", "kind": "tool", "name": "Hand scanner", "network": "TESLA-TOOLS", "ap": "11", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:06", "kind": "tool", "name": "Hand scanner", "network": "TESLA-TOOLS", "ap": "12", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:07", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "13", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:08", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "14", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:09", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "15", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:0a", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "16", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:0b", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "17", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:0c", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "18", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:0d", "kind": "tool", "name": "Label printer", "network": "TESLA-TOOLS", "ap": "19", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:0e", "kind": "tool", "name": "Label printer", "network": "TESLA-TOOLS", "ap": "1a", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:0f", "kind": "tool", "name": "Coffee machine (IoT)", "network": "TESLA-TOOLS", "ap": "1b", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:10", "kind": "tool", "name": "Coffee machine (IoT)", "network": "TESLA-TOOLS", "ap": "1c", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:11", "kind": "tool", "name": "Test device", "network": "TESLA-TOOLS", "ap": "1d", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:12", "kind": "tool", "name": "Test device", "network": "TESLA-TOOLS", "ap": "1e", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:13", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "01", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:14", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "02", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:15", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "03", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:16", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "04", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:17", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "05", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:18", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "06", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:19", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "07", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:1a", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "08", "dx": -30.0, "dy": 40.0},
  {"mac": "b8:27:eb:00:00:1b", "kind": "tool", "name": "Torque tool", "network": "TESLA-TOOLS", "ap": "09", "dx": -30.0, "dy": 40.0},
  {"mac": "f0:18:98:00:00:01", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "06", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:02", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "07", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:03", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "08", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:04", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "09", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:05", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "0a", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:06", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "0b", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:07", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "0c", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:08", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "0d", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:09", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "0e", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:0a", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "0f", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:0b", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "10", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:0c", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "11", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:0d", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "12", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:0e", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "13", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:0f", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "14", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:10", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "15", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:11", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "16", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:12", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "17", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:13", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "18", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:14", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "19", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:15", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "1a", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:16", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "1b", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:17", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "1c", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:18", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "1d", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:19", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "1e", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:1a", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "01", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:1b", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "02", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:1c", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "03", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:1d", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "04", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:1e", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "05", "dx": 0.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:1f", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "06", "dx": 16.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:20", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "07", "dx": 16.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:21", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "08", "dx": 16.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:22", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "09", "dx": 16.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:23", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "0a", "dx": 16.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:24", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "0b", "dx": 16.0, "dy": 54.0},
  {"mac": "f0:18:98:00:00:25", "kind": "phone", "name": "Phone", "network": "TESLA-CORP", "ap": "0c", "dx": 16.0, "dy": 54.0},
];

export type LineId = "L1" | "L2" | "L3";

// Row A sits at line 1, rows B-C at line 2, rows D-E at line 3
export function lineOfCell(cell: string): LineId {
  const r = cell[0];
  return r === "A" ? "L1" : r === "B" || r === "C" ? "L2" : "L3";
}

export function placeInWords(cell: string) {
  return `Line ${lineOfCell(cell).slice(1)} · bay ${cell}`;
}

export function deviceLabel(d: FloorDevice) {
  return `${d.name} ${d.cell}`;
}

// Devices follow their AP to wherever it is drawn
export function placeDevices(aps: FloorAp[]): FloorDevice[] {
  const byNum = new Map(aps.map((a) => [a.num, a]));
  return FLOOR_DEVICE_SPECS.map((d) => {
    const ap = byNum.get(d.ap)!;
    return { ...d, x: ap.x + d.dx, y: ap.y + d.dy, cell: ap.cell };
  });
}

const SLOTS = FLOOR_APS.map(({ cell, x, y }) => ({ cell, x, y }));

// Estimated positions (lib/api SiteLayout, from signal strength) decide which AP takes which grid
// slot, so APs that are neighbours on the air are neighbours on the plan. The grid and the hall stay.
// Of the 8 mirror/rotation variants of the estimate, the one closest to the numbered order is used,
// so the picture changes no more than the measurement demands. Radios not on the air keep the
// slots that are left over, in number order.
export function placeAps(layout: SiteLayout | undefined): FloorAp[] {
  if (!layout?.aps.length) return FLOOR_APS;
  const pos = new Map<string, { x: number; y: number }>();
  for (const a of layout.aps) {
    const ap = FLOOR_APS.find((f) =>
      a.bssids.some((b) => b.toLowerCase() === f.corp || b.toLowerCase() === f.tools),
    );
    if (ap) pos.set(ap.num, { x: a.x, y: a.y });
  }
  if (pos.size < 2) return FLOOR_APS;

  const xs = SLOTS.map((s) => s.x);
  const ys = SLOTS.map((s) => s.y);
  const box = {
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    y0: Math.min(...ys),
    y1: Math.max(...ys),
  };
  const variants: ((p: { x: number; y: number }) => { x: number; y: number })[] = [
    (p) => p,
    (p) => ({ x: -p.x, y: p.y }),
    (p) => ({ x: p.x, y: -p.y }),
    (p) => ({ x: -p.x, y: -p.y }),
    (p) => ({ x: p.y, y: p.x }),
    (p) => ({ x: -p.y, y: p.x }),
    (p) => ({ x: p.y, y: -p.x }),
    (p) => ({ x: -p.y, y: -p.x }),
  ];

  let best: { cost: number; slotOf: Map<string, number> } | null = null;
  for (const v of variants) {
    const pts = [...pos].map(([num, p]) => ({ num, ...v(p) }));
    const px = pts.map((p) => p.x);
    const py = pts.map((p) => p.y);
    const [ax0, ax1, ay0, ay1] = [Math.min(...px), Math.max(...px), Math.min(...py), Math.max(...py)];
    const scaled = pts.map((p) => ({
      num: p.num,
      x: box.x0 + ((p.x - ax0) / (ax1 - ax0 || 1)) * (box.x1 - box.x0),
      y: box.y0 + ((p.y - ay0) / (ay1 - ay0 || 1)) * (box.y1 - box.y0),
    }));
    // greedy nearest free slot, most confident (closest) pairs first
    const pairs: { num: string; slot: number; d: number }[] = [];
    for (const p of scaled)
      SLOTS.forEach((s, i) => pairs.push({ num: p.num, slot: i, d: Math.hypot(p.x - s.x, p.y - s.y) }));
    pairs.sort((a, b) => a.d - b.d);
    const slotOf = new Map<string, number>();
    const taken = new Set<number>();
    for (const q of pairs) {
      if (slotOf.has(q.num) || taken.has(q.slot)) continue;
      slotOf.set(q.num, q.slot);
      taken.add(q.slot);
    }
    // distance to the numbered order decides between the variants
    let cost = 0;
    for (const [num, i] of slotOf) {
      const home = FLOOR_APS.find((a) => a.num === num)!;
      cost += Math.hypot(SLOTS[i].x - home.x, SLOTS[i].y - home.y);
    }
    if (!best || cost < best.cost) best = { cost, slotOf };
  }

  const slotOf = best!.slotOf;
  const free = SLOTS.map((_, i) => i).filter((i) => ![...slotOf.values()].includes(i));
  return FLOOR_APS.map((a) => {
    const i = slotOf.get(a.num) ?? free.shift()!;
    const s = SLOTS[i];
    return { ...a, cell: s.cell, x: s.x, y: s.y };
  });
}
