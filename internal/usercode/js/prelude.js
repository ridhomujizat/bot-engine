// Prelude for bot user code. Evaluated once per execution as
//   (function (native) { ... return exports; })
// `native` is the Go-side helper object (see natives.go). The returned object
// holds the Buffer, URLSearchParams, axios, form-data and crypto modules.
(function (native) {
  'use strict';

  // ---------------------------------------------------------------- Buffer
  var HEX = '0123456789abcdef';

  function normEncoding(enc) {
    var e = String(enc || 'utf8').toLowerCase();
    if (e === 'utf-8') return 'utf8';
    if (e === 'binary') return 'latin1';
    return e;
  }

  function bytesFromString(str, enc) {
    switch (normEncoding(enc)) {
      case 'utf8':
        return new Uint8Array(native.utf8Encode(String(str)));
      case 'hex': {
        var n = Math.floor(str.length / 2);
        var out = new Uint8Array(n);
        for (var i = 0; i < n; i++) {
          var v = parseInt(str.substr(i * 2, 2), 16);
          if (isNaN(v)) return out.subarray(0, i);
          out[i] = v;
        }
        return out;
      }
      case 'base64':
      case 'base64url':
        return new Uint8Array(native.base64Decode(String(str)));
      case 'latin1':
      case 'ascii': {
        var b = new Uint8Array(str.length);
        for (var j = 0; j < str.length; j++) b[j] = str.charCodeAt(j) & 0xff;
        return b;
      }
      default:
        throw new TypeError('Unknown encoding: ' + enc);
    }
  }

  function stringFromBytes(u8, enc) {
    switch (normEncoding(enc)) {
      case 'utf8':
        return native.utf8Decode(u8);
      case 'hex': {
        var h = '';
        for (var i = 0; i < u8.length; i++) h += HEX[u8[i] >> 4] + HEX[u8[i] & 15];
        return h;
      }
      case 'base64':
        return native.base64Encode(u8);
      case 'base64url':
        return native.base64Encode(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      case 'latin1':
      case 'ascii': {
        var s = '';
        for (var j = 0; j < u8.length; j++) s += String.fromCharCode(u8[j]);
        return s;
      }
      default:
        throw new TypeError('Unknown encoding: ' + enc);
    }
  }

  function concatBytes(list) {
    var total = 0;
    for (var i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var k = 0; k < list.length; k++) {
      out.set(list[k], off);
      off += list[k].length;
    }
    return out;
  }

  class Buffer extends Uint8Array {
    static from(value, encOrOffset, length) {
      if (typeof value === 'string') return new Buffer(bytesFromString(value, encOrOffset));
      if (value instanceof ArrayBuffer) return new Buffer(value);
      if (value && typeof value === 'object' && typeof value.length === 'number') {
        var b = new Buffer(value.length);
        for (var i = 0; i < value.length; i++) b[i] = value[i] & 0xff;
        return b;
      }
      throw new TypeError('The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.');
    }
    static alloc(size, fill) {
      var b = new Buffer(size);
      if (fill !== undefined) b.fill(typeof fill === 'string' ? fill.charCodeAt(0) : fill);
      return b;
    }
    static allocUnsafe(size) {
      return new Buffer(size);
    }
    static isBuffer(v) {
      return v instanceof Buffer;
    }
    static byteLength(str, enc) {
      return typeof str === 'string' ? bytesFromString(str, enc).length : str.length;
    }
    static concat(list, total) {
      var merged = concatBytes(list);
      if (total !== undefined) merged = merged.subarray(0, total);
      return new Buffer(merged);
    }
    toString(enc, start, end) {
      var s = start === undefined ? 0 : start;
      var e = end === undefined ? this.length : end;
      return stringFromBytes(this.subarray(s, e), enc);
    }
    toJSON() {
      return { type: 'Buffer', data: Array.prototype.slice.call(this) };
    }
    equals(other) {
      if (this.length !== other.length) return false;
      for (var i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
      return true;
    }
  }

  // ------------------------------------------------------ URLSearchParams
  class URLSearchParams {
    constructor(init) {
      this._pairs = [];
      if (typeof init === 'string') {
        var s = init.charAt(0) === '?' ? init.slice(1) : init;
        if (s.length) {
          s.split('&').forEach(function (part) {
            if (!part) return;
            var idx = part.indexOf('=');
            var k = idx < 0 ? part : part.slice(0, idx);
            var v = idx < 0 ? '' : part.slice(idx + 1);
            this._pairs.push([decodeForm(k), decodeForm(v)]);
          }, this);
        }
      } else if (init && typeof init === 'object') {
        var keys = Object.keys(init);
        for (var i = 0; i < keys.length; i++) this._pairs.push([keys[i], String(init[keys[i]])]);
      }
    }
    append(k, v) { this._pairs.push([String(k), String(v)]); }
    set(k, v) {
      var found = false;
      this._pairs = this._pairs.filter(function (p) {
        if (p[0] !== String(k)) return true;
        if (found) return false;
        found = true;
        p[1] = String(v);
        return true;
      });
      if (!found) this.append(k, v);
    }
    get(k) {
      for (var i = 0; i < this._pairs.length; i++) if (this._pairs[i][0] === String(k)) return this._pairs[i][1];
      return null;
    }
    has(k) { return this.get(k) !== null; }
    delete(k) { this._pairs = this._pairs.filter(function (p) { return p[0] !== String(k); }); }
    toString() {
      return this._pairs.map(function (p) {
        return encodeForm(p[0]) + '=' + encodeForm(p[1]);
      }).join('&');
    }
  }
  function encodeForm(s) {
    return encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()~]/g, function (c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }
  function decodeForm(s) {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch (e) {
      return s;
    }
  }

  // ----------------------------------------------------------- form-data
  function randomDigits(n) {
    var bytes = native.randomBytes(n);
    var s = '';
    for (var i = 0; i < n; i++) s += String(bytes[i] % 10);
    return s;
  }

  class FormData {
    constructor() {
      this._boundary = '--------------------------' + randomDigits(24);
      this._parts = [];
    }
    append(key, value, options) {
      var filename;
      var contentType;
      if (typeof options === 'string') {
        filename = options;
      } else if (options && typeof options === 'object') {
        filename = options.filename;
        contentType = options.contentType;
      }
      this._parts.push({ key: String(key), value: value, filename: filename, contentType: contentType });
    }
    getHeaders() {
      return { 'content-type': 'multipart/form-data; boundary=' + this._boundary };
    }
    getBoundary() {
      return this._boundary;
    }
    getBuffer() {
      var chunks = [];
      var self = this;
      this._parts.forEach(function (part) {
        var head = '--' + self._boundary + '\r\n';
        var disp = 'Content-Disposition: form-data; name="' + part.key + '"';
        var v = part.value;
        var isBin = v instanceof Uint8Array;
        if (part.filename !== undefined) disp += '; filename="' + part.filename + '"';
        var ctype = part.contentType;
        if (!ctype && (isBin || part.filename !== undefined)) ctype = 'application/octet-stream';
        head += disp + '\r\n';
        if (ctype) head += 'Content-Type: ' + ctype + '\r\n';
        head += '\r\n';
        chunks.push(Buffer.from(head, 'utf8'));
        if (isBin) {
          chunks.push(v);
        } else if (typeof v === 'object' && v !== null) {
          chunks.push(Buffer.from(JSON.stringify(v), 'utf8'));
        } else {
          chunks.push(Buffer.from(String(v), 'utf8'));
        }
        chunks.push(Buffer.from('\r\n', 'utf8'));
      });
      chunks.push(Buffer.from('--' + this._boundary + '--\r\n', 'utf8'));
      return Buffer.concat(chunks);
    }
  }
  FormData.prototype.__isFormData = true;

  // ---------------------------------------------------------------- qs
  // (qs itself is loaded from the embedded package, see modules.go)

  // -------------------------------------------------------------- crypto
  function toBytes(data, enc) {
    if (data instanceof Uint8Array) return data;
    return Buffer.from(String(data), enc);
  }
  function normAlg(alg) {
    var a = String(alg).toLowerCase().replace('-', '');
    if (['md5', 'sha1', 'sha256', 'sha384', 'sha512'].indexOf(a) < 0) {
      throw new Error('Digest method not supported');
    }
    return a;
  }
  function encodeOut(bytes, enc) {
    var out = new Buffer(bytes);
    return enc === undefined ? out : out.toString(enc);
  }
  var cryptoModule = {
    createHash: function (alg) {
      var a = normAlg(alg);
      var chunks = [];
      var h = {
        update: function (data, enc) {
          chunks.push(toBytes(data, enc));
          return h;
        },
        digest: function (enc) {
          return encodeOut(native.hash(a, concatBytes(chunks)), enc);
        }
      };
      return h;
    },
    createHmac: function (alg, key) {
      var a = normAlg(alg);
      var k = toBytes(key);
      var chunks = [];
      var h = {
        update: function (data, enc) {
          chunks.push(toBytes(data, enc));
          return h;
        },
        digest: function (enc) {
          return encodeOut(native.hmac(a, k, concatBytes(chunks)), enc);
        }
      };
      return h;
    },
    randomBytes: function (n) {
      return new Buffer(native.randomBytes(n));
    },
    randomUUID: function () {
      var b = native.randomBytes(16);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var h = stringFromBytes(b, 'hex');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
    }
  };

  // --------------------------------------------------------------- axios
  var ABS_URL = /^([a-z][a-z\d+\-.]*:)?\/\//i;
  var METHOD_GROUPS = ['common', 'delete', 'get', 'head', 'post', 'put', 'patch'];

  function makeError(message, config, code, response) {
    var err = new Error(message);
    err.config = config;
    err.code = code === undefined ? null : code;
    err.request = {};
    err.response = response;
    err.isAxiosError = true;
    return err;
  }

  function encodeParam(v) {
    return encodeURIComponent(v)
      .replace(/%3A/gi, ':')
      .replace(/%24/g, '$')
      .replace(/%2C/gi, ',')
      .replace(/%20/g, '+')
      .replace(/%5B/gi, '[')
      .replace(/%5D/gi, ']');
  }

  function buildURL(url, params) {
    if (!params) return url;
    var parts = [];
    Object.keys(params).forEach(function (key) {
      var val = params[key];
      if (val === null || val === undefined) return;
      var list = Array.isArray(val) ? val : [val];
      var k = Array.isArray(val) ? key + '[]' : key;
      list.forEach(function (v) {
        if (v instanceof Date) v = v.toISOString();
        else if (v !== null && typeof v === 'object') v = JSON.stringify(v);
        parts.push(encodeParam(k) + '=' + encodeParam(v));
      });
    });
    var serialized = parts.join('&');
    if (!serialized) return url;
    var hash = url.indexOf('#');
    if (hash !== -1) url = url.slice(0, hash);
    return url + (url.indexOf('?') === -1 ? '?' : '&') + serialized;
  }

  function combineURL(base, rel) {
    if (!base || ABS_URL.test(rel)) return rel;
    return base.replace(/\/+$/, '') + '/' + rel.replace(/^\/+/, '');
  }

  function mergeHeaders(defaults, method, own) {
    var out = {};
    var add = function (src) {
      if (!src) return;
      Object.keys(src).forEach(function (k) { out[k] = src[k]; });
    };
    if (defaults) {
      add(defaults.common);
      add(defaults[method]);
      Object.keys(defaults).forEach(function (k) {
        if (METHOD_GROUPS.indexOf(k) < 0 && typeof defaults[k] !== 'object') out[k] = defaults[k];
      });
    }
    add(own);
    return out;
  }

  function findHeader(headers, name) {
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === name) return keys[i];
    return undefined;
  }

  function createAxios(defaults) {
    defaults = defaults || {};

    function request(a, b) {
      var config = typeof a === 'string' ? Object.assign({}, b, { url: a }) : Object.assign({}, a);
      var method = String(config.method || 'get').toLowerCase();
      var base = config.baseURL !== undefined ? config.baseURL : defaults.baseURL;
      var timeout = config.timeout !== undefined ? config.timeout : (defaults.timeout || 0);
      var validate = config.validateStatus || defaults.validateStatus || function (s) { return s >= 200 && s < 300; };
      var headers = mergeHeaders(defaults.headers, method, config.headers);
      var url = combineURL(base, config.url || '');
      url = buildURL(url, Object.assign({}, defaults.params, config.params));

      var body;
      var data = config.data;
      if (data !== undefined && data !== null) {
        var ctKey = findHeader(headers, 'content-type');
        var setCT = function (v) {
          if (ctKey === undefined) { headers['Content-Type'] = v; ctKey = 'Content-Type'; }
        };
        if (data instanceof FormData) {
          body = data.getBuffer();
          var fh = data.getHeaders();
          Object.keys(fh).forEach(function (k) {
            if (findHeader(headers, k.toLowerCase()) === undefined) headers[k] = fh[k];
          });
          ctKey = findHeader(headers, 'content-type');
        } else if (data instanceof URLSearchParams) {
          body = data.toString();
          setCT('application/x-www-form-urlencoded;charset=utf-8');
        } else if (data instanceof Uint8Array) {
          body = data;
          setCT('application/octet-stream');
        } else if (typeof data === 'string') {
          body = data;
          setCT('application/x-www-form-urlencoded');
        } else {
          body = JSON.stringify(data);
          setCT('application/json;charset=utf-8');
        }
      }
      if (findHeader(headers, 'accept') === undefined) headers.Accept = 'application/json, text/plain, */*';
      if (findHeader(headers, 'user-agent') === undefined) headers['User-Agent'] = 'axios/0.21.1';

      var spec = {
        method: method.toUpperCase(),
        url: url,
        headers: headers,
        body: body,
        timeout: timeout
      };
      var responseType = config.responseType || 'json';

      return native.httpRequest(spec).then(
        function (raw) {
          var data = raw.body;
          if (responseType === 'json' && typeof data === 'string' && data.length) {
            try { data = JSON.parse(data); } catch (e) { /* keep raw text, like axios */ }
          }
          var response = {
            data: data,
            status: raw.status,
            statusText: raw.statusText,
            headers: raw.headers,
            config: config,
            request: {}
          };
          if (!validate(raw.status)) {
            throw makeError('Request failed with status code ' + raw.status, config, null, response);
          }
          return response;
        },
        function (err) {
          if (err && err.isAxiosError) throw err;
          throw makeError(err.message, config, err.code, undefined);
        }
      );
    }

    request.request = request;
    request.defaults = defaults;
    request.get = function (url, cfg) { return request(Object.assign({}, cfg, { method: 'get', url: url })); };
    request.delete = function (url, cfg) { return request(Object.assign({}, cfg, { method: 'delete', url: url })); };
    request.head = function (url, cfg) { return request(Object.assign({}, cfg, { method: 'head', url: url })); };
    request.options = function (url, cfg) { return request(Object.assign({}, cfg, { method: 'options', url: url })); };
    ['post', 'put', 'patch'].forEach(function (m) {
      request[m] = function (url, data, cfg) {
        return request(Object.assign({}, cfg, { method: m, url: url, data: data }));
      };
    });
    request.create = function (cfg) {
      var merged = Object.assign({}, defaults, cfg);
      merged.headers = Object.assign({}, defaults.headers, cfg && cfg.headers);
      merged.params = Object.assign({}, defaults.params, cfg && cfg.params);
      return createAxios(merged);
    };
    request.all = function (list) { return Promise.all(list); };
    request.spread = function (fn) { return function (arr) { return fn.apply(null, arr); }; };
    request.isAxiosError = function (e) { return !!(e && e.isAxiosError); };
    request.default = request;
    return request;
  }

  return {
    Buffer: Buffer,
    URLSearchParams: URLSearchParams,
    modules: {
      axios: createAxios({}),
      'form-data': FormData,
      crypto: cryptoModule,
      buffer: { Buffer: Buffer },
      url: { URLSearchParams: URLSearchParams }
    }
  };
})
