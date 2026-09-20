const { EventEmitter } = require('events');

class Logger extends EventEmitter {
  constructor(maxBuffer = 500) {
    super();
    this.buffer = [];
    this.maxBuffer = maxBuffer;
    this._patch();
  }

  _patch() {
    const emit = (level, args) => {
      const text = args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.message;
        return JSON.stringify(a);
      }).join(' ');
      const entry = { ts: Date.now(), level, text };
      this.buffer.push(entry);
      if (this.buffer.length > this.maxBuffer) this.buffer.shift();
      this.emit('line', entry);
    };

    const _log = console.log.bind(console);
    const _warn = console.warn.bind(console);
    const _error = console.error.bind(console);

    console.log = (...args) => { _log(...args); emit('info', args); };
    console.warn = (...args) => { _warn(...args); emit('warn', args); };
    console.error = (...args) => { _error(...args); emit('error', args); };
  }

  getRecent() {
    return this.buffer;
  }
}

// Singleton
const logger = new Logger();
module.exports = logger;
