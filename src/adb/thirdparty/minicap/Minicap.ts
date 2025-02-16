import { Duplex, EventEmitter } from 'node:stream';
import DeviceClient from '../../DeviceClient';
import PromiseDuplex from 'promise-duplex';
import Debug from 'debug';
import net from 'node:net';
import ThirdUtils from "../ThirdUtils";
import { Utils } from "../../..";
import PromiseSocket from "promise-socket";

export interface MinicapOptions {
  /**
   * {RealWidth}x{RealHeight}@{VirtualWidth}x{VirtualHeight}/{Orientation}
   */
  dimention: string;
}

const debug = Debug('minicap');

/**
 * enforce EventEmitter typing
 */
interface IEmissions {
  data: (data: Buffer) => void
  error: (error: Error) => void
  disconnect: () => void
}

export default class Minicap extends EventEmitter {
  private config: MinicapOptions;
  private videoSocket: PromiseDuplex<Duplex> | undefined;
  private minicapServer: PromiseDuplex<Duplex> | undefined;

  /** 0=255 */
  private _version: Promise<number>;
  private _pid: Promise<number>;
  private _realWidth: Promise<number>;
  private _realHigth: Promise<number>;
  private _virtualWidth: Promise<number>;
  private _virtualHigth: Promise<number>;
  private _orientation: Promise<number>;
  private _bitflags: Promise<number>;

  private setVersion: (version: number) => void;
  private setPid: (version: number) => void;
  private setRealWidth: (width: number) => void;
  private setRealHigth: (height: number) => void;
  private setVirtualWidth: (width: number) => void;
  private setVirtualHigth: (height: number) => void;
  private setOrientation: (height: number) => void;
  private setBitflags: (height: number) => void;

  constructor(private client: DeviceClient, config = {} as Partial<MinicapOptions>) {
    super();
    this.config = {
      dimention: '',
      ...config,
    }
    this._version = new Promise<number>((resolve) => this.setVersion = resolve);
    this._pid = new Promise<number>((resolve) => this.setPid = resolve);
    this._realWidth = new Promise<number>((resolve) => this.setRealWidth = resolve);
    this._realHigth = new Promise<number>((resolve) => this.setRealHigth = resolve);
    this._virtualWidth = new Promise<number>((resolve) => this.setVirtualWidth = resolve);
    this._virtualHigth = new Promise<number>((resolve) => this.setVirtualHigth = resolve);
    this._orientation = new Promise<number>((resolve) => this.setOrientation = resolve);
    this._bitflags = new Promise<number>((resolve) => this.setBitflags = resolve);
  }

  public on = <K extends keyof IEmissions>(event: K, listener: IEmissions[K]): this => super.on(event, listener)
  public off = <K extends keyof IEmissions>(event: K, listener: IEmissions[K]): this => super.off(event, listener)
  public once = <K extends keyof IEmissions>(event: K, listener: IEmissions[K]): this => super.once(event, listener)
  public emit = <K extends keyof IEmissions>(event: K, ...args: Parameters<IEmissions[K]>): boolean => super.emit(event, ...args)

  get version(): Promise<number> { return this._version; }
  get pid(): Promise<number> { return this._pid; }
  get realwidth(): Promise<number> { return this._realWidth; }
  get realheight(): Promise<number> { return this._realHigth; }
  get vitualWidth(): Promise<number> { return this._virtualWidth; }
  get vitualHeight(): Promise<number> { return this._virtualHigth; }
  /**
   * return virtual width
   */
  get width(): Promise<number> { return this._virtualWidth; }
  /**
   * return virtual heigth
   */
  get height(): Promise<number> { return this._virtualHigth; }

  get orientation(): Promise<number> { return this._orientation; }
  /**
   * return full bitflags, QuickDumb, QuickAlwaysUpright and QuickTear can be used.
   */
  get bitflags(): Promise<number> { return this._bitflags; }
  /**
   * Frames will get sent even if there are no changes from the previous frame. Informative, doesn't require any actions on your part. You can limit the capture rate by reading frame data slower in your own code if you wish.
   */
  get QuickDumb(): Promise<boolean> { return this.bitflags.then(v => !!(v & 1)); }
  /**
   * 	The frame will always be in upright orientation regardless of the device orientation. This needs to be taken into account when rendering the image.
   */
  get QuickAlwaysUpright(): Promise<boolean> { return this.bitflags.then(v => !!(v & 2)); }
  /**
   * Frame tear might be visible. Informative, no action required. Neither of our current two methods exhibit this behavior.
   */
  get QuickTear(): Promise<boolean> { return this.bitflags.then(v => !!(v & 4)); }

  async start(): Promise<this> {
    const props = await this.client.getProperties();
    const abi = props['ro.product.cpu.abi'];
    const sdkLevel = parseInt(props['ro.build.version.sdk']);
    const minicapName = (sdkLevel >= 16) ? 'minicap' : 'minicap-nopie';

    let binFile: string;
    let soFile: string;

    try {
      binFile = require.resolve(`@devicefarmer/minicap-prebuilt/prebuilt/${abi}/bin/${minicapName}`);
    } catch (e) {
      throw Error(`minicap not found in @devicefarmer/minicap-prebuilt/prebuilt/${abi}/bin/ please install @devicefarmer/minicap-prebuilt to use minicap`);
    }

    try {
      soFile = require.resolve(`@devicefarmer/minicap-prebuilt/prebuilt/${abi}/lib/android-${sdkLevel}/minicap.so`);
    } catch (e) {
      throw Error(`minicap.so for your device check for @devicefarmer/minicap-prebuilt update that support android-${sdkLevel}`);
    }

    try {
      await this.client.push(binFile, '/data/local/tmp/minicap', 0o755);
    } catch (e) {
      // allready running ?
    }
    try {
      await this.client.push(soFile, '/data/local/tmp/minicap.so', 0o755);
    } catch (e) {
      // allready running ?
    }
    // await this.client.push(apkFile, '/data/local/tmp/minicap.apk', 0o755);
    // adb push libs/$ABI/minicap /data/local/tmp/

    const args = ['LD_LIBRARY_PATH=/data/local/tmp/', 'exec', '/data/local/tmp/minicap']
    {
      args.push('-P')
      if (!this.config.dimention) {
        const {x, y} = await ThirdUtils.getScreenSize(this.client);
        const dim = `${x}x${y}`;
        args.push(`${dim}@${dim}/0`);
      } else {
        args.push(this.config.dimention)
      }
    }
    this.minicapServer = new PromiseDuplex(await this.client.shell(args.map(a => a.toString()).join(' ')));
    // minicap: PID: 14231
    // INFO: Using projection 1080x2376@1080x2376/0
    // INFO: (external/MY_minicap/src/minicap_30.cpp:243) Creating SurfaceComposerClient
    // INFO: (external/MY_minicap/src/minicap_30.cpp:246) Performing SurfaceComposerClient init check
    // INFO: (external/MY_minicap/src/minicap_30.cpp:257) Creating virtual display
    // INFO: (external/MY_minicap/src/minicap_30.cpp:263) Creating buffer queue
    // INFO: (external/MY_minicap/src/minicap_30.cpp:266) Setting buffer options
    // INFO: (external/MY_minicap/src/minicap_30.cpp:270) Creating CPU consumer
    // INFO: (external/MY_minicap/src/minicap_30.cpp:274) Creating frame waiter
    // INFO: (external/MY_minicap/src/minicap_30.cpp:278) Publishing virtual display
    // INFO: (jni/minicap/JpgEncoder.cpp:64) Allocating 7783428 bytes for JPG encoder
    // if (!Utils.waitforReadable(this.minicapServer, this.config.tunnelDelay)) {
    //   // try to read error
    //   const out = await this.minicapServer.setEncoding('utf8').readAll();
    //   console.log('read minicapServer stdOut:', out);
    // }
    await Utils.waitforText(this.minicapServer, 'JpgEncoder');
    this.videoSocket = new PromiseSocket(new net.Socket());

    // Connect videoSocket
    try {
      this.videoSocket = await this.client.openLocal2('localabstract:minicap');
    } catch (e) {
      debug(`Impossible to connect video Socket localabstract:minicap`, e);
      throw e;
    }
    void this.startStream().catch(() => this.stop());
    // wait until first stream chunk is recieved
    await this.bitflags;
    return this;
  }

  private async startStream() {
    // first chunk 24
    try {
      await Utils.waitforReadable(this.videoSocket);
      let firstChunk = await this.videoSocket.read(2) as Buffer;
      if (!firstChunk) {
        throw Error('fail to read firstChunk, inclease tunnelDelay for this device.');
      }
      this.setVersion(firstChunk[0]); // == 1
      const len = firstChunk[1]; // == 24
      firstChunk = await this.videoSocket.read(len - 2) as Buffer;
      this.setPid(firstChunk.readUint32LE(0));
      this.setRealWidth(firstChunk.readUint32LE(4));
      this.setRealHigth(firstChunk.readUint32LE(8));
      this.setVirtualWidth(firstChunk.readUint32LE(12));
      this.setVirtualHigth(firstChunk.readUint32LE(16));
      this.setOrientation(firstChunk.readUint8(20));
      this.setBitflags(firstChunk.readUint8(21));
    } catch (e) {
      debug('Impossible to read first chunk:', e);
      throw e;
    }
    for (; ;) {
      await Utils.waitforReadable(this.videoSocket);
      let chunk = this.videoSocket.stream.read(4) as Buffer;
      let len = chunk.readUint32LE(0);
      // len -= 4;
      let streamChunk: Buffer | null = null;
      while (streamChunk === null) {
        await Utils.waitforReadable(this.videoSocket);
        chunk = this.videoSocket.stream.read(len) as Buffer;
        if (chunk) {
          len -= chunk.length;
          if (!streamChunk)
            streamChunk = chunk;
          else {
            streamChunk = Buffer.concat([streamChunk, chunk]);
          }
          if (streamChunk[0] !== 0xFF || streamChunk[1] !== 0xD8) {
            console.error('Frame body does not start with JPG header');
            return;
          }  
        }
        if (len === 0) {
          this.emit('data', streamChunk);
          break;
        } else {
          await Utils.delay(0);
        }
      }
    }
  }

  public stop(): boolean {
    let close = false;
    if (this.videoSocket) {
      this.videoSocket.destroy();
      this.videoSocket = undefined;
      close = true;
    }
    if (this.minicapServer) {
      this.minicapServer.destroy();
      this.minicapServer = undefined;
      close = true;
    }
    if (close)
      this.emit('disconnect');
    return close;
  }

  isRunning(): boolean {
    return this.videoSocket !== null;
  }
}
