// What each measurement is, for reading a scan: its name in the report, a title, what it tells a
// backend, and its group -- the hooks, gadgets and changes in memory first. The titles and
// descriptions follow the integration guide's sections 6 and 8.
import type { PersonalMeasurement } from '@necessarysdk/react-native';

export type MeasurementGroup = "hooks" | "app" | "system" | "device" | "personal";

/** What a group of measurements catches, in the order a scan is read. */
export const groups: { name: MeasurementGroup; title: string; note: string }[] = [
  { name: "hooks", title: "Hooks, gadgets and memory changes", note: "Frida and other instrumentation, found by name, by port, by thread and by memory layout; debuggers and tracers; and the code in memory compared with its file, where an inline hook changes bytes. A backend asks for every one of these on every scan." },
  { name: "app", title: "The app as built", note: "What is installed: its identity, its hashes and its signer." },
  { name: "system", title: "Root, jailbreak and the system", note: "Traces of root or a jailbreak, and how the system is set up." },
  { name: "device", title: "Device and network", note: "Sent with every scan, asked for or not." },
  { name: "personal", title: "Personal measurements", note: "Asked for by the backend, and measured only where this app turned them on." },
];

export interface MeasurementInfo {
  name: string;
  title: string;
  about: string;
  group: MeasurementGroup;
}

export const androidMeasurements: MeasurementInfo[] = [
  { name: "runtime_maps", title: "Memory map", about: "Instrumentation and hooking frameworks named in the app's memory map: Frida, its gadget, Objection, Xposed and others.", group: "hooks" },
  { name: "frida_ports", title: "Frida ports", about: "Frida's default local ports accepting connections.", group: "hooks" },
  { name: "instrumentation_threads", title: "Instrumentation threads", about: "Threads an instrumentation runtime creates, even renamed.", group: "hooks" },
  { name: "exec_mappings", title: "Executable memory", about: "Memory both writable and executable, executable memory from deleted files, unlabelled executable regions: where injected code lives.", group: "hooks" },
  { name: "code_integrity", title: "Code integrity", about: "The app's native code and the system libraries in memory compared with their files: an inline hook changes bytes, and diff_bytes counts them.", group: "hooks" },
  { name: "tracer", title: "Tracer", about: "Another process tracing the app.", group: "hooks" },
  { name: "debug_state", title: "Debugger", about: "A Java debugger attached or awaited.", group: "hooks" },
  { name: "app_identity", title: "App identity", about: "The installed app: package, the base APK hash, signing certificates, flags, install source and split APKs.", group: "app" },
  { name: "root_files", title: "Root files", about: "Known root, su and framework paths that exist; a test-keys build.", group: "system" },
  { name: "root_shell", title: "Root shell", about: "Whether su resolves from the app's shell.", group: "system" },
  { name: "system_properties", title: "System properties", about: "Build and boot-security properties.", group: "system" },
  { name: "selinux", title: "SELinux", about: "The SELinux mode, read two ways.", group: "system" },
  { name: "mounts", title: "Mounts", about: "System partitions mounted writable.", group: "system" },
  { name: "developer_settings", title: "Developer settings", about: "Developer options and USB debugging.", group: "system" },
  { name: "emulator", title: "Emulator", about: "Build values typical of an emulator.", group: "system" },
  { name: "device", title: "Device", about: "The OS version, security patch level, model, build, the app's ABI and memory page size.", group: "device" },
  { name: "network", title: "Network", about: "A VPN up on any network; an HTTP proxy set.", group: "device" },
];

export const iosMeasurements: MeasurementInfo[] = [
  { name: "dyld_images", title: "Loaded libraries", about: "Instrumentation and jailbreak names among the loaded libraries: Frida, its gadget, Cycript, Substrate and others.", group: "hooks" },
  { name: "environment", title: "Environment", about: "Libraries injected through the environment.", group: "hooks" },
  { name: "code_integrity", title: "Code integrity", about: "The app's code in memory compared with its file, image by image: an inline hook changes bytes, and app_diff_bytes counts them.", group: "hooks" },
  { name: "debugger", title: "Debugger", about: "A debugger tracing the process.", group: "hooks" },
  { name: "app_identity", title: "App identity", about: "The installed app and its executable's hash.", group: "app" },
  { name: "code_signing", title: "Code signing", about: "The executable's own code signature.", group: "app" },
  { name: "jailbreak_files", title: "Jailbreak files", about: "Known jailbreak paths that exist.", group: "system" },
  { name: "sandbox", title: "Sandbox", about: "Whether the app can write outside its sandbox.", group: "system" },
  { name: "simulator", title: "Simulator", about: "The simulator, and the hardware model.", group: "system" },
  { name: "device", title: "Device", about: "The OS version and build, the model and the memory page size.", group: "device" },
  { name: "network", title: "Network", about: "A VPN, inferred from the interfaces the proxy settings are scoped to; an HTTP proxy.", group: "device" },
];

export const personalCatalog: MeasurementInfo[] = [
  { name: "local_addresses", title: "Local addresses", about: "The phone's own IP addresses, link-local ones left out.", group: "personal" },
  { name: "accessibility", title: "Accessibility", about: "The Accessibility services that are on, and the keyboard in use. Android only.", group: "personal" },
  { name: "notification_access", title: "Notification access", about: "The apps allowed to read notifications. Android only.", group: "personal" },
  { name: "other_access", title: "Other access", about: "Device-administrator apps, and known remote-control apps installed. Android only.", group: "personal" },
  { name: "screen_capture", title: "Screen capture", about: "The screen being recorded, mirrored or cast.", group: "personal" },
  { name: "location", title: "Location", about: "The last location the phone already knows: never a fresh fix, never a prompt. Needs the location permission.", group: "personal" },
  { name: "mock_location", title: "Mock location", about: "Whether that location was faked.", group: "personal" },
];

/** The catalog entry of one personal measurement. */
export function personalInfo(measurement: PersonalMeasurement): MeasurementInfo {
  return personalCatalog.find((info) => info.name === measurement) as MeasurementInfo;
}
