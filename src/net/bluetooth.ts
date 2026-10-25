/**
 * 蓝牙传输（可插拔）。
 *
 * 现实约束，先讲清楚，因为这是本项目最容易「装不上」的一环：
 *  - Windows / Linux：经典蓝牙 RFCOMM（串口模拟）需要原生模块
 *    （bluetooth-serial-port，需 node-gyp + Python + C++ 工具链）。
 *  - macOS：系统禁止第三方访问经典蓝牙 SPP，只有 BLE（noble / @abandonware/noble，
 *    需要 Xcode CLI 且 macOS 权限逐年收紧）。
 *
 * 因此这里的策略（用户已确认）：
 *   1. 蓝牙是**可选** transport，装不上不影响 LAN/WiFi/热点主链路。
 *   2. 用动态 import 探测可选依赖，缺什么报什么，绝不硬崩。
 *   3. 提供「降级为手动 IP 直连」的提示路径。
 *
 * 另外提供一条**零依赖的蓝牙替代通道**：如果两台机器已通过蓝牙配对
 * （操作系统层面已建立网络），LAN 发现通常也能直接跑；因此 BluetoothBridge
 * 主要承担「设备扫描 + 引导用户走 LAN 」的职责。
 */

import { EventEmitter } from 'node:events';
import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import type { BluetoothAdapter, BluetoothDevice, BluetoothSession, Transport } from './transport.js';

export type BluetoothFlavor = 'rfcomm' | 'ble' | 'none';

export function platformFlavor(): BluetoothFlavor {
  switch (process.platform) {
    case 'win32':
    case 'linux':
      return 'rfcomm';
    case 'darwin':
      return 'ble';
    default:
      return 'none';
  }
}

/** 把底层流包装成 Transport（蓝牙/串口都是字节流） */
class StreamTransport extends EventEmitter implements Transport {
  readonly info = {
    kind: 'bt' as const,
    remote: 'bluetooth',
    local: 'bluetooth',
    mtu: 990, // RFCOMM 常见有效载荷上限，保守取 990
    reliable: true,
  };
  private open = true;

  constructor(
    private stream: { write(d: Buffer): void; end(): void; on(ev: string, cb: (...a: never[]) => void): void },
    remote: string,
  ) {
    super();
    this.info.remote = remote;
    this.stream.on('data', ((d: Buffer) => this.emit('data', Buffer.from(d))) as never);
    this.stream.on('close', (() => {
      this.open = false;
      this.emit('close', null);
    }) as never);
    this.stream.on('error', ((e: Error) => this.emit('error', e)) as never);
  }

  get connected(): boolean {
    return this.open;
  }

  send(data: Buffer): void {
    if (!this.open) return;
    // RFCOMM MTU 小：交给上层分片，这里只管写
    this.stream.write(data);
  }

  close(): void {
    this.open = false;
    try {
      this.stream.end();
    } catch {
      /* ignore */
    }
  }
}

/**
 * RFCOMM 适配器（Windows / Linux）。
 * 依赖可选包 `bluetooth-serial-port`；未安装时 available() 返回 false。
 */
class RfcommAdapter implements BluetoothAdapter {
  readonly kind = 'bt' as const;
  private mod: unknown = null;
  private probed = false;
  private reason = '';
  private server: { listen: (...a: never[]) => void; close: () => void } | null = null;

  available(): boolean {
    this.probe();
    return this.mod !== null;
  }

  unavailableReason(): string {
    this.probe();
    return this.reason;
  }

  private probe(): void {
    if (this.probed) return;
    this.probed = true;
    try {
      // 同步探测：ESM 下用 createRequire 回落到 CJS 加载
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createRequire } = require('node:module') as typeof import('node:module');
      const req = createRequire(import.meta.url);
      this.mod = req('bluetooth-serial-port');
    } catch (e) {
      this.mod = null;
      this.reason =
        `bluetooth-serial-port 未安装或加载失败（需要 node-gyp 编译环境）。` +
        `可运行: npm i bluetooth-serial-port；或直接用 LAN 模式（--transport tcp）。` +
        `原始错误: ${(e as Error).message}`;
    }
  }

  async scan(timeoutMs = 5000): Promise<BluetoothDevice[]> {
    if (!this.available()) throw new Error(this.unavailableReason());
    const btSerial = this.mod as {
      inquireSync?: () => { name: string; address: string }[];
      findSerialPortChannel?: (addr: string, cb: (ch: number) => void) => void;
      inquire?: () => void;
      on?: (ev: string, cb: (...a: never[]) => void) => void;
    };
    // 优先同步接口
    if (typeof btSerial.inquireSync === 'function') {
      const found = btSerial.inquireSync();
      return found.map((d) => ({ name: d.name ?? 'unknown', address: d.address }));
    }
    // 异步接口
    return new Promise((resolve) => {
      const out: BluetoothDevice[] = [];
      const inst = new (this.mod as { new (): typeof btSerial })();
      inst.on?.('found', ((addr: string, name: string) => {
        out.push({ name, address: addr });
      }) as never);
      inst.on?.('finished', (() => resolve(out)) as never);
      inst.inquire?.();
      setTimeout(() => resolve(out), timeoutMs);
    });
  }

  async advertise(serviceName: string): Promise<BluetoothSession> {
    if (!this.available()) throw new Error(this.unavailableReason());
    const Ctor = this.mod as unknown as {
      BluetoothSerialPort: new () => {
        listen: (cb: (...a: never[]) => void, err: (e: Error) => void, opts: unknown) => void;
        close: () => void;
      };
    };
    if (!Ctor.BluetoothSerialPort) throw new Error('bluetooth-serial-port 导出异常：缺少 BluetoothSerialPort');
    const server = new Ctor.BluetoothSerialPort();
    this.server = server as never;
    return new Promise((resolve, reject) => {
      server.listen(
        ((...args: unknown[]) => {
          const [addr, , sock] = args as [string, unknown, { write: (d: Buffer) => void; end: () => void; on: (ev: string, cb: (...a: unknown[]) => void) => void }];
          const t = new StreamTransport(sock as never, `bt:${addr}`);
          resolve({ transport: t, device: { name: serviceName, address: addr }, close: () => t.close() });
        }) as never,
        ((e: Error) => reject(e)) as never,
        { uuid: '00001101-0000-1000-8000-00805F9B34FB', name: serviceName },
      );
    });
  }

  async connect(device: BluetoothDevice): Promise<BluetoothSession> {
    if (!this.available()) throw new Error(this.unavailableReason());
    const Ctor = this.mod as unknown as {
      BluetoothSerialPort: new () => {
        findSerialPortChannel: (addr: string, cb: (ch: number) => void, err: (e: Error) => void) => void;
        connect: (addr: string, ch: number, ok: () => void, err: (e: Error) => void) => void;
        on: (ev: string, cb: (...a: never[]) => void) => void;
        write: (d: Buffer) => void;
        close: () => void;
        end: () => void;
      };
    };
    const client = new Ctor.BluetoothSerialPort();
    const channel = await new Promise<number>((resolve, reject) => {
      client.findSerialPortChannel(device.address, resolve, reject);
    });
    await new Promise<void>((resolve, reject) => {
      client.connect(device.address, channel, () => resolve(), (e: Error) => reject(e));
    });
    const t = new StreamTransport(client as never, `bt:${device.address}`);
    return { transport: t, device, close: () => t.close() };
  }

  stop(): void {
    try {
      this.server?.close();
    } catch {
      /* ignore */
    }
    this.server = null;
  }
}

/**
 * BLE 适配器（macOS 及支持 BLE 的平台）。
 * 依赖可选包 `@abandonware/noble`。
 */
class BleAdapter implements BluetoothAdapter {
  readonly kind = 'bt' as const;
  private mod: unknown = null;
  private probed = false;
  private reason = '';
  private scanning = false;

  available(): boolean {
    this.probe();
    return this.mod !== null;
  }

  unavailableReason(): string {
    this.probe();
    return this.reason;
  }

  private probe(): void {
    if (this.probed) return;
    this.probed = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createRequire } = require('node:module') as typeof import('node:module');
      this.mod = createRequire(import.meta.url)('@abandonware/noble');
    } catch (e) {
      this.mod = null;
      this.reason =
        `@abandonware/noble 未安装（macOS 上 BLE 需要它 + 蓝牙权限）。` +
        `可运行: npm i @abandonware/noble；或用 LAN 模式（--transport tcp）。` +
        `原始错误: ${(e as Error).message}`;
    }
  }

  async scan(timeoutMs = 5000): Promise<BluetoothDevice[]> {
    if (!this.available()) throw new Error(this.unavailableReason());
    const noble = this.mod as {
      state: string;
      on: (ev: string, cb: (...a: never[]) => void) => void;
      startScanning: (svc?: string[], allowDup?: boolean) => void;
      stopScanning: () => void;
      removeAllListeners: (ev?: string) => void;
    };
    if (noble.state !== 'poweredOn') {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('蓝牙适配器未开启（state=' + noble.state + '）')), 4000);
        noble.on('stateChange', ((s: string) => {
          if (s === 'poweredOn') {
            clearTimeout(t);
            resolve();
          }
        }) as never);
      });
    }
    return new Promise((resolve) => {
      const out = new Map<string, BluetoothDevice>();
      noble.on('discover', ((p: { id: string; advertisement?: { localName?: string }; rssi?: number }) => {
        out.set(p.id, {
          name: p.advertisement?.localName ?? p.id,
          address: p.id,
          rssi: p.rssi !== undefined ? Math.max(0, Math.min(1, (p.rssi + 100) / 70)) : undefined,
        });
      }) as never);
      this.scanning = true;
      noble.startScanning([], true);
      setTimeout(() => {
        noble.stopScanning();
        this.scanning = false;
        resolve(Array.from(out.values()));
      }, timeoutMs);
    });
  }

  async advertise(_serviceName: string): Promise<BluetoothSession> {
    // BLE 外设模式在 Node 上需要 bleno（另一个原生模块），不纳入 MVP
    throw new Error(
      'macOS 的 BLE 外设模式需要额外原生模块（bleno），MVP 阶段未提供。' +
        '请在 macOS 上作为**发起方**连接 Windows/Linux 的 RFCOMM 服务，或直接使用 LAN 模式。',
    );
  }

  async connect(_device: BluetoothDevice): Promise<BluetoothSession> {
    throw new Error('BLE GATT 客户端通道在 MVP 阶段未提供，请使用 LAN 模式（--transport tcp）。');
  }

  stop(): void {
    if (this.scanning) {
      try {
        (this.mod as { stopScanning: () => void }).stopScanning();
      } catch {
        /* ignore */
      }
      this.scanning = false;
    }
  }
}

/** 空适配器：平台不支持时返回，保证调用链不崩 */
class NullAdapter implements BluetoothAdapter {
  readonly kind = 'bt' as const;
  constructor(private why: string) {}
  available(): boolean {
    return false;
  }
  unavailableReason(): string {
    return this.why;
  }
  async scan(): Promise<BluetoothDevice[]> {
    return [];
  }
  async advertise(): Promise<BluetoothSession> {
    throw new Error(this.why);
  }
  async connect(): Promise<BluetoothSession> {
    throw new Error(this.why);
  }
  stop(): void {
    /* noop */
  }
}

/** 取得当前平台可用的蓝牙适配器 */
export function createBluetoothAdapter(): BluetoothAdapter {
  const flavor = platformFlavor();
  if (flavor === 'rfcomm') return new RfcommAdapter();
  if (flavor === 'ble') return new BleAdapter();
  return new NullAdapter(`当前平台 ${os.platform()} 未纳入蓝牙支持；请使用 LAN 模式。`);
}

/** 给用户看的一句话状态 */
export function bluetoothStatus(): { available: boolean; flavor: BluetoothFlavor; message: string } {
  const a = createBluetoothAdapter();
  return {
    available: a.available(),
    flavor: platformFlavor(),
    message: a.available()
      ? `蓝牙可用（${platformFlavor()}）`
      : a.unavailableReason(),
  };
}

export const bluetooth = {
  createBluetoothAdapter,
  bluetoothStatus,
  platformFlavor,
  StreamTransport,
};
export default bluetooth;
