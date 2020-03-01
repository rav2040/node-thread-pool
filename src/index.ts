import { Worker } from 'worker_threads';
import { cpus } from 'os';

const maxNumWorkers = cpus().length;
const defaultNumWorkers = maxNumWorkers - 1;

class WorkerPool {
  readonly #numWorkers: number;
  readonly #timeouts: NodeJS.Timeout[] = [];

  #initialized = false;
  #stopped = true;
  #destroyed = false;

  #workerFunctions: { [name: string]: (...args: any[]) => any } = {};

  private readonly _seq = createRepeatingSequence();
  private readonly _workers: Worker[] = [];
  private readonly _queue: { n: number, name: string, value: any }[] = [];
  private readonly _callbacks: Map<number, (value: any) => void> = new Map();

  get numWorkers() {
    return this.#numWorkers;
  }

  get initialized() {
    return this.#initialized;
  }

  get stopped() {
    return this.#stopped;
  }

  get destroyed() {
    return this.#destroyed;
  }

  get workerFunctions() {
    return this.#workerFunctions;
  }

  constructor(options: { numWorkers?: number | 'max' } = {}) {
    if (!options.numWorkers) {
      this.#numWorkers = defaultNumWorkers;
    }

    else {
      if (options.numWorkers === 'max') {
        this.#numWorkers = maxNumWorkers;
      }

      else {
        this.#numWorkers = options.numWorkers <= maxNumWorkers
          ? options.numWorkers
          : maxNumWorkers;
      }
    }
  }

  add(name: string, func: (...args: any[]) => any) {
    if (this.#initialized) {
      throw Error('The worker pool has already been initialized.');
    }

    if (this.#destroyed) {
      throw Error('The worker pool has been destroyed');
    }

    this.#workerFunctions[name] = func;

    return this;
  }

  init() {
    if (this.#initialized) {
      throw Error('The worker pool has already been initialized.');
    }

    if (this.#destroyed) {
      throw Error('The worker pool has been destroyed.');
    }

    let code = 'const { parentPort } = require(\'worker_threads\');';

    code += 'const funcs = {';

    for (const [name, func] of Object.entries(this.#workerFunctions)) {
      code += `${name}: ${func},`;
    }

    code += '}';

    code += `
      parentPort.on('message', async (jobs) => {
        for (const job of jobs) {
          const func = funcs[job.name];
          if (Array.isArray(job.value)) {
            job.value = await func(...job.value);
            continue;
          }
          job.value = func(job.value);
        }
        parentPort.postMessage(jobs);
      });
    `;

    for (let i = 0; i < this.#numWorkers; i++) {
      const worker = new Worker(code, { eval: true });

      worker.on('message', (results) => {
        for (const { n, value } of results) {
          const callback = this._callbacks.get(n);
          callback?.(value);
          this._callbacks.delete(n);

        }
      });

      this._workers.push(worker);
    }

    this.#initialized = true;

    this.start();

    return this;
  }

  start() {
    if (!this.#stopped) {
      return;
    }

    if (!this.#initialized) {
      throw Error('The worker pool has not been initialized.');
    }

    if (this.#destroyed) {
      throw Error('The worker pool has been destroyed.');
    }

    for (const [n, worker] of this._workers.entries()) {
      worker.ref();

      const processJobs = () => {
        const jobs = this._queue.splice(0);

        if (jobs.length === 0) {
          this.#timeouts[n] = setTimeout(processJobs, 10);
          return;
        }

        worker.once('message', () => {
          this.#timeouts[n] = setTimeout(processJobs, 0);
        });

        worker.postMessage(jobs);
      };

      this.#timeouts[n] = setTimeout(processJobs, 0);
    }

    this.#stopped = false;

    return this;
  }

  stop() {
    if (this.#stopped) {
      return;
    }

    if (!this.#initialized) {
      throw Error('The worker pool has not been initialized.');
    }

    if (this.#destroyed) {
      throw Error('The worker pool has been destroyed.');
    }

    for (const [n, worker] of this._workers.entries()) {
      clearTimeout(this.#timeouts[n]);
      worker.unref();
    }

    this.#stopped = true;

    return this;
  }

  exec(name: string, ...args: any[]) {
    return new Promise<any>((resolve, reject) => {
      let err: Error | undefined;

      if (this.#stopped) {
        err = Error('The worker pool is stopped.');
      }

      else if (!this.#initialized) {
        err = Error('The worker pool has not been initialized.');
      }

      else if (this.#destroyed) {
        err = Error('The worker pool has been destroyed.');
      }

      if (err) {
        reject(err);
        return;
      }

      const n = this._seq() as number;
      const value = args;
      this._callbacks.set(n, resolve);
      this._queue.push({ n, name, value });
    });
  }

  destroy() {
    return new Promise<number>((resolve, reject) => {
      if (this.#destroyed) {
        resolve(0);
        return;
      }

      if (!this.#stopped) {
        this.stop();
      }

      setImmediate(async () => {
        for (const worker of this._workers) {
          const exitCode = await worker.terminate();

          if (exitCode !== 1) {
            const err = Error(`Worker ${worker.threadId} failed to terminate.`);
            reject(err);
            return;
          }
        }

        this.#destroyed = true;

        resolve(1);
      });
    });
  }
}

function createRepeatingSequence(start = 0, end = Number.MAX_SAFE_INTEGER) {
  let n = start;

  return () => {
    const value = n;
    n = n < end ? n + 1 : 0;
    return value;
  };
}

export { WorkerPool };
