var Ds = Object.defineProperty;
var Fs = (e, t, n) => t in e ? Ds(e, t, { enumerable: !0, configurable: !0, writable: !0, value: n }) : e[t] = n;
var Xt = (e, t, n) => Fs(e, typeof t != "symbol" ? t + "" : t, n);
const Ns = (e, t) => e === t, Os = Symbol("solid-track"), Be = {
  equals: Ns
};
let Kn = Jn;
const Gt = 1, $e = 2, jn = {
  owned: null,
  cleanups: null,
  context: null,
  owner: null
};
var J = null;
let ze = null, Ps = null, ot = null, pt = null, Nt = null, Oe = 0;
function Te(e, t) {
  const n = ot, s = J, i = e.length === 0, r = t === void 0 ? s : t, o = i ? jn : {
    owned: null,
    cleanups: null,
    context: r ? r.context : null,
    owner: r
  }, a = i ? e : () => e(() => Ot(() => ge(o)));
  J = o, ot = null;
  try {
    return be(a, !0);
  } finally {
    ot = n, J = s;
  }
}
function gt(e, t) {
  t = t ? Object.assign({}, Be, t) : Be;
  const n = {
    value: e,
    observers: null,
    observerSlots: null,
    comparator: t.equals || void 0
  }, s = (i) => (typeof i == "function" && (i = i(n.value)), Zn(n, i));
  return [qn.bind(n), s];
}
function yt(e, t, n) {
  const s = rn(e, t, !1, Gt);
  ye(s);
}
function de(e, t, n) {
  Kn = Vs;
  const s = rn(e, t, !1, Gt);
  s.user = !0, Nt ? Nt.push(s) : ye(s);
}
function Wt(e, t, n) {
  n = n ? Object.assign({}, Be, n) : Be;
  const s = rn(e, t, !0, 0);
  return s.observers = null, s.observerSlots = null, s.comparator = n.equals || void 0, ye(s), qn.bind(s);
}
function Ot(e) {
  if (ot === null) return e();
  const t = ot;
  ot = null;
  try {
    return e();
  } finally {
    ot = t;
  }
}
function sn(e) {
  de(() => Ot(e));
}
function pe(e) {
  return J === null || (J.cleanups === null ? J.cleanups = [e] : J.cleanups.push(e)), e;
}
function Ws(e, t) {
  const n = Symbol("context");
  return {
    id: n,
    Provider: Xs(n),
    defaultValue: e
  };
}
function Hs(e) {
  let t;
  return J && J.context && (t = J.context[e.id]) !== void 0 ? t : e.defaultValue;
}
function Us(e) {
  const t = Wt(e), n = Wt(() => Ke(t()));
  return n.toArray = () => {
    const s = n();
    return Array.isArray(s) ? s : s != null ? [s] : [];
  }, n;
}
function qn() {
  if (this.sources && this.state)
    if (this.state === Gt) ye(this);
    else {
      const e = pt;
      pt = null, be(() => _e(this), !1), pt = e;
    }
  if (ot) {
    const e = this.observers;
    if (!e || e[e.length - 1] !== ot) {
      const t = e ? e.length : 0;
      ot.sources ? (ot.sources.push(this), ot.sourceSlots.push(t)) : (ot.sources = [this], ot.sourceSlots = [t]), e ? (e.push(ot), this.observerSlots.push(ot.sources.length - 1)) : (this.observers = [ot], this.observerSlots = [ot.sources.length - 1]);
    }
  }
  return this.value;
}
function Zn(e, t, n) {
  let s = e.value;
  return (!e.comparator || !e.comparator(s, t)) && (e.value = t, e.observers && e.observers.length && be(() => {
    for (let i = 0; i < e.observers.length; i += 1) {
      const r = e.observers[i], o = ze && ze.running;
      o && ze.disposed.has(r), (o ? !r.tState : !r.state) && (r.pure ? pt.push(r) : Nt.push(r), r.observers && Qn(r)), o || (r.state = Gt);
    }
    if (pt.length > 1e6)
      throw pt = [], new Error();
  }, !1)), t;
}
function ye(e) {
  if (!e.fn) return;
  ge(e);
  const t = Oe;
  zs(e, e.value, t);
}
function zs(e, t, n) {
  let s;
  const i = J, r = ot;
  ot = J = e;
  try {
    s = e.fn(t);
  } catch (o) {
    return e.pure && (e.state = Gt, e.owned && e.owned.forEach(ge), e.owned = null), e.updatedAt = n + 1, ts(o);
  } finally {
    ot = r, J = i;
  }
  (!e.updatedAt || e.updatedAt <= n) && (e.updatedAt != null && "observers" in e ? Zn(e, s) : e.value = s, e.updatedAt = n);
}
function rn(e, t, n, s = Gt, i) {
  const r = {
    fn: e,
    state: s,
    updatedAt: null,
    owned: null,
    sources: null,
    sourceSlots: null,
    cleanups: null,
    value: t,
    owner: J,
    context: J ? J.context : null,
    pure: n
  };
  return J === null || J !== jn && (J.owned ? J.owned.push(r) : J.owned = [r]), r;
}
function Re(e) {
  if (e.state === 0) return;
  if (e.state === $e) return _e(e);
  if (e.suspense && Ot(e.suspense.inFallback)) return e.suspense.effects.push(e);
  const t = [e];
  for (; (e = e.owner) && (!e.updatedAt || e.updatedAt < Oe); )
    e.state && t.push(e);
  for (let n = t.length - 1; n >= 0; n--)
    if (e = t[n], e.state === Gt)
      ye(e);
    else if (e.state === $e) {
      const s = pt;
      pt = null, be(() => _e(e, t[0]), !1), pt = s;
    }
}
function be(e, t) {
  if (pt) return e();
  let n = !1;
  t || (pt = []), Nt ? n = !0 : Nt = [], Oe++;
  try {
    const s = e();
    return Gs(n), s;
  } catch (s) {
    n || (Nt = null), pt = null, ts(s);
  }
}
function Gs(e) {
  if (pt && (Jn(pt), pt = null), e) return;
  const t = Nt;
  Nt = null, t.length && be(() => Kn(t), !1);
}
function Jn(e) {
  for (let t = 0; t < e.length; t++) Re(e[t]);
}
function Vs(e) {
  let t, n = 0;
  for (t = 0; t < e.length; t++) {
    const s = e[t];
    s.user ? e[n++] = s : Re(s);
  }
  for (t = 0; t < n; t++) Re(e[t]);
}
function _e(e, t) {
  e.state = 0;
  for (let n = 0; n < e.sources.length; n += 1) {
    const s = e.sources[n];
    if (s.sources) {
      const i = s.state;
      i === Gt ? s !== t && (!s.updatedAt || s.updatedAt < Oe) && Re(s) : i === $e && _e(s, t);
    }
  }
}
function Qn(e) {
  for (let t = 0; t < e.observers.length; t += 1) {
    const n = e.observers[t];
    n.state || (n.state = $e, n.pure ? pt.push(n) : Nt.push(n), n.observers && Qn(n));
  }
}
function ge(e) {
  let t;
  if (e.sources)
    for (; e.sources.length; ) {
      const n = e.sources.pop(), s = e.sourceSlots.pop(), i = n.observers;
      if (i && i.length) {
        const r = i.pop(), o = n.observerSlots.pop();
        s < i.length && (r.sourceSlots[o] = s, i[s] = r, n.observerSlots[s] = o);
      }
    }
  if (e.tOwned) {
    for (t = e.tOwned.length - 1; t >= 0; t--) ge(e.tOwned[t]);
    delete e.tOwned;
  }
  if (e.owned) {
    for (t = e.owned.length - 1; t >= 0; t--) ge(e.owned[t]);
    e.owned = null;
  }
  if (e.cleanups) {
    for (t = e.cleanups.length - 1; t >= 0; t--) e.cleanups[t]();
    e.cleanups = null;
  }
  e.state = 0;
}
function Ys(e) {
  return e instanceof Error ? e : new Error(typeof e == "string" ? e : "Unknown error", {
    cause: e
  });
}
function ts(e, t = J) {
  throw Ys(e);
}
function Ke(e) {
  if (typeof e == "function" && !e.length) return Ke(e());
  if (Array.isArray(e)) {
    const t = [];
    for (let n = 0; n < e.length; n++) {
      const s = Ke(e[n]);
      if (Array.isArray(s))
        if (s.length < 32768) t.push.apply(t, s);
        else for (let i = 0; i < s.length; i++) t.push(s[i]);
      else
        t.push(s);
    }
    return t;
  }
  return e;
}
function Xs(e, t) {
  return function(s) {
    let i;
    return yt(() => i = Ot(() => (J.context = {
      ...J.context,
      [e]: s.value
    }, Us(() => s.children))), void 0), i;
  };
}
const Ks = Symbol("fallback");
function yn(e) {
  for (let t = 0; t < e.length; t++) e[t]();
}
function js(e, t, n = {}) {
  let s = [], i = [], r = [], o = 0, a = t.length > 1 ? [] : null;
  return pe(() => yn(r)), () => {
    let l = e() || [], c = l.length, u, h;
    return l[Os], Ot(() => {
      let g, p, m, k, E, x, y, R, T;
      if (c === 0)
        o !== 0 && (yn(r), r = [], s = [], i = [], o = 0, a && (a = [])), n.fallback && (s = [Ks], i[0] = Te((f) => (r[0] = f, n.fallback())), o = 1);
      else if (o === 0) {
        for (i = new Array(c), h = 0; h < c; h++)
          s[h] = l[h], i[h] = Te(v);
        o = c;
      } else {
        for (m = new Array(c), k = new Array(c), a && (E = new Array(c)), x = 0, y = Math.min(o, c); x < y && s[x] === l[x]; x++) ;
        for (y = o - 1, R = c - 1; y >= x && R >= x && s[y] === l[R]; y--, R--)
          m[R] = i[y], k[R] = r[y], a && (E[R] = a[y]);
        for (g = /* @__PURE__ */ new Map(), p = new Array(R + 1), h = R; h >= x; h--)
          T = l[h], u = g.get(T), p[h] = u === void 0 ? -1 : u, g.set(T, h);
        for (u = x; u <= y; u++)
          T = s[u], h = g.get(T), h !== void 0 && h !== -1 ? (m[h] = i[u], k[h] = r[u], a && (E[h] = a[u]), h = p[h], g.set(T, h)) : r[u]();
        for (h = x; h < c; h++)
          h in m ? (i[h] = m[h], r[h] = k[h], a && (a[h] = E[h], a[h](h))) : i[h] = Te(v);
        i = i.slice(0, o = c), s = l.slice(0);
      }
      return i;
    });
    function v(g) {
      if (r[h] = g, a) {
        const [p, m] = gt(h);
        return a[h] = m, t(l[h], p);
      }
      return t(l[h]);
    }
  };
}
function nt(e, t) {
  return Ot(() => e(t || {}));
}
const qs = (e) => `Stale read from <${e}>.`;
function Kt(e) {
  const t = "fallback" in e && {
    fallback: () => e.fallback
  };
  return Wt(js(() => e.each, e.children, t || void 0));
}
function Rt(e) {
  const t = e.keyed, n = Wt(() => e.when, void 0, void 0), s = t ? n : Wt(n, void 0, {
    equals: (i, r) => !i == !r
  });
  return Wt(() => {
    const i = s();
    if (i) {
      const r = e.children;
      return typeof r == "function" && r.length > 0 ? Ot(() => r(t ? i : () => {
        if (!Ot(s)) throw qs("Show");
        return n();
      })) : r;
    }
    return e.fallback;
  }, void 0, void 0);
}
const jt = (e) => Wt(() => e());
function Zs(e, t, n) {
  let s = n.length, i = t.length, r = s, o = 0, a = 0, l = t[i - 1].nextSibling, c = null;
  for (; o < i || a < r; ) {
    if (t[o] === n[a]) {
      o++, a++;
      continue;
    }
    for (; t[i - 1] === n[r - 1]; )
      i--, r--;
    if (i === o) {
      const u = r < s ? a ? n[a - 1].nextSibling : n[r - a] : l;
      for (; a < r; ) e.insertBefore(n[a++], u);
    } else if (r === a)
      for (; o < i; )
        (!c || !c.has(t[o])) && t[o].remove(), o++;
    else if (t[o] === n[r - 1] && n[a] === t[i - 1]) {
      const u = t[--i].nextSibling;
      e.insertBefore(n[a++], t[o++].nextSibling), e.insertBefore(n[--r], u), t[i] = n[r];
    } else {
      if (!c) {
        c = /* @__PURE__ */ new Map();
        let h = a;
        for (; h < r; ) c.set(n[h], h++);
      }
      const u = c.get(t[o]);
      if (u != null)
        if (a < u && u < r) {
          let h = o, v = 1, g;
          for (; ++h < i && h < r && !((g = c.get(t[h])) == null || g !== u + v); )
            v++;
          if (v > u - a) {
            const p = t[o];
            for (; a < u; ) e.insertBefore(n[a++], p);
          } else e.replaceChild(n[a++], t[o++]);
        } else o++;
      else t[o++].remove();
    }
  }
}
const bn = "_$DX_DELEGATE";
function Js(e, t, n, s = {}) {
  let i;
  return Te((r) => {
    i = r, t === document ? e() : G(t, e(), t.firstChild ? null : void 0, n);
  }, s.owner), () => {
    i(), t.textContent = "";
  };
}
function ut(e, t, n, s) {
  let i;
  const r = () => {
    const a = document.createElement("template");
    return a.innerHTML = e, a.content.firstChild;
  }, o = () => (i || (i = r())).cloneNode(!0);
  return o.cloneNode = o, o;
}
function es(e, t = window.document) {
  const n = t[bn] || (t[bn] = /* @__PURE__ */ new Set());
  for (let s = 0, i = e.length; s < i; s++) {
    const r = e[s];
    n.has(r) || (n.add(r), t.addEventListener(r, Qs));
  }
}
function Ie(e, t, n) {
  n == null ? e.removeAttribute(t) : e.setAttribute(t, n);
}
function Pt(e, t, n) {
  n != null ? e.style.setProperty(t, n) : e.style.removeProperty(t);
}
function te(e, t, n) {
  return Ot(() => e(t, n));
}
function G(e, t, n, s) {
  if (n !== void 0 && !s && (s = []), typeof t != "function") return Ee(e, t, s, n);
  yt((i) => Ee(e, t(), i, n), s);
}
function Qs(e) {
  let t = e.target;
  const n = `$$${e.type}`, s = e.target, i = e.currentTarget, r = (l) => Object.defineProperty(e, "target", {
    configurable: !0,
    value: l
  }), o = () => {
    const l = t[n];
    if (l && !t.disabled) {
      const c = t[`${n}Data`];
      if (c !== void 0 ? l.call(t, c, e) : l.call(t, e), e.cancelBubble) return;
    }
    return t.host && typeof t.host != "string" && !t.host._$host && t.contains(e.target) && r(t.host), !0;
  }, a = () => {
    for (; o() && (t = t._$host || t.parentNode || t.host); ) ;
  };
  if (Object.defineProperty(e, "currentTarget", {
    configurable: !0,
    get() {
      return t || document;
    }
  }), e.composedPath) {
    const l = e.composedPath();
    r(l[0]);
    for (let c = 0; c < l.length - 2 && (t = l[c], !!o()); c++) {
      if (t._$host) {
        t = t._$host, a();
        break;
      }
      if (t.parentNode === i)
        break;
    }
  } else a();
  r(s);
}
function Ee(e, t, n, s, i) {
  for (; typeof n == "function"; ) n = n();
  if (t === n) return n;
  const r = typeof t, o = s !== void 0;
  if (e = o && n[0] && n[0].parentNode || e, r === "string" || r === "number") {
    if (r === "number" && (t = t.toString(), t === n))
      return n;
    if (o) {
      let a = n[0];
      a && a.nodeType === 3 ? a.data !== t && (a.data = t) : a = document.createTextNode(t), n = qt(e, n, s, a);
    } else
      n !== "" && typeof n == "string" ? n = e.firstChild.data = t : n = e.textContent = t;
  } else if (t == null || r === "boolean")
    n = qt(e, n, s);
  else {
    if (r === "function")
      return yt(() => {
        let a = t();
        for (; typeof a == "function"; ) a = a();
        n = Ee(e, a, n, s);
      }), () => n;
    if (Array.isArray(t)) {
      const a = [], l = n && Array.isArray(n);
      if (je(a, t, n, i))
        return yt(() => n = Ee(e, a, n, s, !0)), () => n;
      if (a.length === 0) {
        if (n = qt(e, n, s), o) return n;
      } else l ? n.length === 0 ? wn(e, a, s) : Zs(e, n, a) : (n && qt(e), wn(e, a));
      n = a;
    } else if (t.nodeType) {
      if (Array.isArray(n)) {
        if (o) return n = qt(e, n, s, t);
        qt(e, n, null, t);
      } else n == null || n === "" || !e.firstChild ? e.appendChild(t) : e.replaceChild(t, e.firstChild);
      n = t;
    }
  }
  return n;
}
function je(e, t, n, s) {
  let i = !1;
  for (let r = 0, o = t.length; r < o; r++) {
    let a = t[r], l = n && n[e.length], c;
    if (!(a == null || a === !0 || a === !1)) if ((c = typeof a) == "object" && a.nodeType)
      e.push(a);
    else if (Array.isArray(a))
      i = je(e, a, l) || i;
    else if (c === "function")
      if (s) {
        for (; typeof a == "function"; ) a = a();
        i = je(e, Array.isArray(a) ? a : [a], Array.isArray(l) ? l : [l]) || i;
      } else
        e.push(a), i = !0;
    else {
      const u = String(a);
      l && l.nodeType === 3 && l.data === u ? e.push(l) : e.push(document.createTextNode(u));
    }
  }
  return i;
}
function wn(e, t, n = null) {
  for (let s = 0, i = t.length; s < i; s++) e.insertBefore(t[s], n);
}
function qt(e, t, n, s) {
  if (n === void 0) return e.textContent = "";
  const i = s || document.createTextNode("");
  if (t.length) {
    let r = !1;
    for (let o = t.length - 1; o >= 0; o--) {
      const a = t[o];
      if (i !== a) {
        const l = a.parentNode === e;
        !r && !o ? l ? e.replaceChild(i, a) : e.insertBefore(i, n) : l && a.remove();
      } else r = !0;
    }
  } else e.insertBefore(i, n);
  return [i];
}
const ns = Uint8Array.of(65, 82, 82, 79, 87, 49), Pe = (
  /** @type {const} */
  {
    /** 0.1.0 (October 2016). */
    V1: 0,
    /** >= 0.8.0 (December 2017). Non-backwards compatible with V3. */
    V4: 3,
    /**
     * >= 1.0.0 (July 2020). Backwards compatible with V4 (V5 readers can read V4
     * metadata and IPC messages). Implementations are recommended to provide a
     * V4 compatibility mode with V5 format changes disabled.
     *
     * Incompatible changes between V4 and V5:
     * - Union buffer layout has changed.
     *   In V5, Unions don't have a validity bitmap buffer.
     */
    V5: 4
  }
), Ft = (
  /** @type {const} */
  {
    NONE: 0,
    /**
     * A Schema describes the columns in a record batch.
     */
    Schema: 1,
    /**
     * For sending dictionary encoding information. Any Field can be
     * dictionary-encoded, but in this case none of its children may be
     * dictionary-encoded.
     * There is one vector / column per dictionary, but that vector / column
     * may be spread across multiple dictionary batches by using the isDelta
     * flag.
     */
    DictionaryBatch: 2,
    /**
     * A data header describing the shared memory layout of a "record" or "row"
     * batch. Some systems call this a "row batch" internally and others a "record
     * batch".
     */
    RecordBatch: 3,
    /**
     * EXPERIMENTAL: Metadata for n-dimensional arrays, aka "tensors" or
     * "ndarrays". Arrow implementations in general are not required to implement
     * this type.
     *
     * Not currently supported by Flechette.
     */
    Tensor: 4,
    /**
     * EXPERIMENTAL: Metadata for n-dimensional sparse arrays, aka "sparse
     * tensors". Arrow implementations in general are not required to implement
     * this type.
     *
     * Not currently supported by Flechette.
     */
    SparseTensor: 5
  }
), b = (
  /** @type {const} */
  {
    /**
     * Dictionary types compress data by using a set of integer indices to
     * lookup potentially repeated vales in a separate dictionary of values.
     *
     * This type entry is provided for API convenience, it does not occur
     * in actual Arrow IPC binary data.
     */
    Dictionary: -1,
    /** No data type. Included for flatbuffer compatibility. */
    NONE: 0,
    /** Null values only. */
    Null: 1,
    /** Integers, either signed or unsigned, with 8, 16, 32, or 64 bit widths. */
    Int: 2,
    /** Floating point numbers with 16, 32, or 64 bit precision. */
    Float: 3,
    /** Opaque binary data. */
    Binary: 4,
    /** Unicode with UTF-8 encoding. */
    Utf8: 5,
    /** Booleans represented as 8 bit bytes. */
    Bool: 6,
    /**
     * Exact decimal value represented as an integer value in two's complement.
     * Currently only 128-bit (16-byte) and 256-bit (32-byte) integers are used.
     * The representation uses the endianness indicated in the schema.
     */
    Decimal: 7,
    /**
     * Date is either a 32-bit or 64-bit signed integer type representing an
     * elapsed time since UNIX epoch (1970-01-01), stored in either of two units:
     * - Milliseconds (64 bits) indicating UNIX time elapsed since the epoch (no
     * leap seconds), where the values are evenly divisible by 86400000
     * - Days (32 bits) since the UNIX epoch
     */
    Date: 8,
    /**
     * Time is either a 32-bit or 64-bit signed integer type representing an
     * elapsed time since midnight, stored in either of four units: seconds,
     * milliseconds, microseconds or nanoseconds.
     *
     * The integer `bitWidth` depends on the `unit` and must be one of the following:
     * - SECOND and MILLISECOND: 32 bits
     * - MICROSECOND and NANOSECOND: 64 bits
     *
     * The allowed values are between 0 (inclusive) and 86400 (=24*60*60) seconds
     * (exclusive), adjusted for the time unit (for example, up to 86400000
     * exclusive for the MILLISECOND unit).
     * This definition doesn't allow for leap seconds. Time values from
     * measurements with leap seconds will need to be corrected when ingesting
     * into Arrow (for example by replacing the value 86400 with 86399).
     */
    Time: 9,
    /**
     * Timestamp is a 64-bit signed integer representing an elapsed time since a
     * fixed epoch, stored in either of four units: seconds, milliseconds,
     * microseconds or nanoseconds, and is optionally annotated with a timezone.
     *
     * Timestamp values do not include any leap seconds (in other words, all
     * days are considered 86400 seconds long).
     *
     * The timezone is an optional string for the name of a timezone, one of:
     *
     *  - As used in the Olson timezone database (the "tz database" or
     *    "tzdata"), such as "America/New_York".
     *  - An absolute timezone offset of the form "+XX:XX" or "-XX:XX",
     *    such as "+07:30".
     *
     * Whether a timezone string is present indicates different semantics about
     * the data.
     */
    Timestamp: 10,
    /**
     * A "calendar" interval which models types that don't necessarily
     * have a precise duration without the context of a base timestamp (e.g.
     * days can differ in length during day light savings time transitions).
     * All integers in the units below are stored in the endianness indicated
     * by the schema.
     *
     *  - YEAR_MONTH - Indicates the number of elapsed whole months, stored as
     *    4-byte signed integers.
     *  - DAY_TIME - Indicates the number of elapsed days and milliseconds (no
     *    leap seconds), stored as 2 contiguous 32-bit signed integers (8-bytes
     *    in total). Support of this IntervalUnit is not required for full arrow
     *    compatibility.
     *  - MONTH_DAY_NANO - A triple of the number of elapsed months, days, and
     *    nanoseconds. The values are stored contiguously in 16-byte blocks.
     *    Months and days are encoded as 32-bit signed integers and nanoseconds
     *    is encoded as a 64-bit signed integer. Nanoseconds does not allow for
     *    leap seconds. Each field is independent (e.g. there is no constraint
     *    that nanoseconds have the same sign as days or that the quantity of
     *    nanoseconds represents less than a day's worth of time).
     */
    Interval: 11,
    /**
     * List (vector) data supporting variably-sized lists.
     * A list has a single child data type for list entries.
     */
    List: 12,
    /**
     * A struct consisting of multiple named child data types.
     */
    Struct: 13,
    /**
     * A union is a complex type with parallel child data types. By default ids
     * in the type vector refer to the offsets in the children. Optionally
     * typeIds provides an indirection between the child offset and the type id.
     * For each child `typeIds[offset]` is the id used in the type vector.
     */
    Union: 14,
    /**
     * Binary data where each entry has the same fixed size.
     */
    FixedSizeBinary: 15,
    /**
     * List (vector) data where every list has the same fixed size.
     * A list has a single child data type for list entries.
     */
    FixedSizeList: 16,
    /**
     * A Map is a logical nested type that is represented as
     * List<entries: Struct<key: K, value: V>>
     *
     * In this layout, the keys and values are each respectively contiguous. We do
     * not constrain the key and value types, so the application is responsible
     * for ensuring that the keys are hashable and unique. Whether the keys are sorted
     * may be set in the metadata for this field.
     *
     * In a field with Map type, the field has a child Struct field, which then
     * has two children: key type and the second the value type. The names of the
     * child fields may be respectively "entries", "key", and "value", but this is
     * not enforced.
     *
     * Map
     * ```text
     *   - child[0] entries: Struct
     *   - child[0] key: K
     *   - child[1] value: V
     *  ```
     * Neither the "entries" field nor the "key" field may be nullable.
     *
     * The metadata is structured so that Arrow systems without special handling
     * for Map can make Map an alias for List. The "layout" attribute for the Map
     * field must have the same contents as a List.
     */
    Map: 17,
    /**
     * An absolute length of time unrelated to any calendar artifacts. For the
     * purposes of Arrow implementations, adding this value to a Timestamp
     * ("t1") naively (i.e. simply summing the two numbers) is acceptable even
     * though in some cases the resulting Timestamp (t2) would not account for
     * leap-seconds during the elapsed time between "t1" and "t2". Similarly,
     * representing the difference between two Unix timestamp is acceptable, but
     * would yield a value that is possibly a few seconds off from the true
     * elapsed time.
     *
     * The resolution defaults to millisecond, but can be any of the other
     * supported TimeUnit values as with Timestamp and Time types. This type is
     * always represented as an 8-byte integer.
     */
    Duration: 18,
    /**
     * Same as Binary, but with 64-bit offsets, allowing representation of
     * extremely large data values.
     */
    LargeBinary: 19,
    /**
     * Same as Utf8, but with 64-bit offsets, allowing representation of
     * extremely large data values.
     */
    LargeUtf8: 20,
    /**
     * Same as List, but with 64-bit offsets, allowing representation of
     * extremely large data values.
     */
    LargeList: 21,
    /**
     * Contains two child arrays, run_ends and values. The run_ends child array
     * must be a 16/32/64-bit integer array which encodes the indices at which
     * the run with the value in each corresponding index in the values child
     * array ends. Like list/struct types, the value array can be of any type.
     */
    RunEndEncoded: 22,
    /**
     * Logically the same as Binary, but the internal representation uses a view
     * struct that contains the string length and either the string's entire data
     * inline (for small strings) or an inlined prefix, an index of another buffer,
     * and an offset pointing to a slice in that buffer (for non-small strings).
     *
     * Since it uses a variable number of data buffers, each Field with this type
     * must have a corresponding entry in `variadicBufferCounts`.
     */
    BinaryView: 23,
    /**
     * Logically the same as Utf8, but the internal representation uses a view
     * struct that contains the string length and either the string's entire data
     * inline (for small strings) or an inlined prefix, an index of another buffer,
     * and an offset pointing to a slice in that buffer (for non-small strings).
     *
     * Since it uses a variable number of data buffers, each Field with this type
     * must have a corresponding entry in `variadicBufferCounts`.
     */
    Utf8View: 24,
    /**
     * Represents the same logical types that List can, but contains offsets and
     * sizes allowing for writes in any order and sharing of child values among
     * list values.
     */
    ListView: 25,
    /**
     * Same as ListView, but with 64-bit offsets and sizes, allowing to represent
     * extremely large data values.
     */
    LargeListView: 26
  }
), ss = (
  /** @type {const} */
  {
    /** 16-bit floating point number. */
    HALF: 0,
    /** 32-bit floating point number. */
    SINGLE: 1,
    /** 64-bit floating point number. */
    DOUBLE: 2
  }
), Ce = (
  /** @type {const} */
  {
    /* Days (as 32 bit int) since the UNIX epoch. */
    DAY: 0,
    /**
     * Milliseconds (as 64 bit int) indicating UNIX time elapsed since the epoch
     * (no leap seconds), with values evenly divisible by 86400000.
     */
    MILLISECOND: 1
  }
), bt = (
  /** @type {const} */
  {
    /** Seconds. */
    SECOND: 0,
    /** Milliseconds. */
    MILLISECOND: 1,
    /** Microseconds. */
    MICROSECOND: 2,
    /** Nanoseconds. */
    NANOSECOND: 3
  }
), ee = (
  /** @type {const} */
  {
    /**
     * Indicates the number of elapsed whole months, stored as 4-byte signed
     * integers.
     */
    YEAR_MONTH: 0,
    /**
     * Indicates the number of elapsed days and milliseconds (no leap seconds),
     * stored as 2 contiguous 32-bit signed integers (8-bytes in total). Support
     * of this IntervalUnit is not required for full arrow compatibility.
     */
    DAY_TIME: 1,
    /**
     * A triple of the number of elapsed months, days, and nanoseconds.
     * The values are stored contiguously in 16-byte blocks. Months and days are
     * encoded as 32-bit signed integers and nanoseconds is encoded as a 64-bit
     * signed integer. Nanoseconds does not allow for leap seconds. Each field is
     * independent (e.g. there is no constraint that nanoseconds have the same
     * sign as days or that the quantity of nanoseconds represents less than a
     * day's worth of time).
     */
    MONTH_DAY_NANO: 2
  }
), on = (
  /** @type {const} */
  {
    /** Sparse union layout with full arrays for each sub-type. */
    Sparse: 0,
    /** Dense union layout with offsets into value arrays. */
    Dense: 1
  }
), is = (
  /** @type {const} */
  {
    /**
     * LZ4 frame compression.
     * Not to be confused with "raw" (also called "block") format.
     */
    LZ4_FRAME: 0,
    /** Zstandard compression. */
    ZSTD: 1
  }
), rs = (
  /** @type {const} */
  {
    /**
     * Each constituent buffer is first compressed with the indicated
     * compressor, and then written with the uncompressed length in the first 8
     * bytes as a 64-bit little-endian signed integer followed by the compressed
     * buffer bytes (and then padding as required by the protocol). The
     * uncompressed length may be set to -1 to indicate that the data that
     * follows is not compressed, which can be useful for cases where
     * compression does not yield appreciable savings.
     */
    BUFFER: 0
  }
), ti = Uint8Array, os = Uint16Array, ei = Uint32Array, as = BigUint64Array, ls = Int8Array, ni = Int16Array, Lt = Int32Array, _t = BigInt64Array, si = Float32Array, We = Float64Array;
function qe(e) {
  return Object.prototype.toString.call(e);
}
function ii(e) {
  return qe(e) === "[object ArrayBuffer]" || qe(e) === "[object SharedArrayBuffer]";
}
function cs(e) {
  return qe(e) === "[object Uint8Array]";
}
function ri(e, t) {
  const n = Math.log2(e) - 3;
  return (t ? [ls, ni, Lt, _t] : [ti, os, ei, as])[n];
}
function an(e, t) {
  let n = 0, s = e.length;
  if (s <= 2147483648)
    do {
      const i = n + s >>> 1;
      e[i] <= t ? n = i + 1 : s = i;
    } while (n < s);
  else
    do {
      const i = Math.trunc((n + s) / 2);
      e[i] <= t ? n = i + 1 : s = i;
    } while (n < s);
  return n;
}
function ln(e, t, n) {
  if (t(e)) return e;
  throw new Error(n(e));
}
function It(e, t, n) {
  return t = Array.isArray(t) ? t : Object.values(t), ln(
    e,
    (s) => t.includes(s),
    n ?? (() => `${e} must be one of ${t}`)
  );
}
function cn(e, t) {
  for (const [n, s] of Object.entries(e))
    if (s === t) return n;
  return "<Unknown>";
}
const hn = (e) => `Unsupported data type: "${cn(b, e)}" (id ${e})`, hs = (e, t, n = !0, s = null) => ({
  name: e,
  type: t,
  nullable: n,
  metadata: s
});
function us(e) {
  return Object.hasOwn(e, "name") && fs(e.type);
}
function fs(e) {
  return typeof e?.typeId == "number";
}
function Ut(e, t = "", n = !0) {
  return us(e) ? e : hs(
    t,
    ln(e, fs, () => "Data type expected."),
    n
  );
}
const oi = (e, t, n = !1, s = -1) => ({
  typeId: b.Dictionary,
  id: s,
  dictionary: e,
  indices: t || ps(),
  ordered: n
}), ds = (e = 32, t = !0) => ({
  typeId: b.Int,
  bitWidth: It(e, [8, 16, 32, 64]),
  signed: t,
  values: ri(e, t)
}), ps = () => ds(32), ai = (e = 2) => ({
  typeId: b.Float,
  precision: It(e, ss),
  values: [os, si, We][e]
}), li = () => ({
  typeId: b.Binary,
  offsets: Lt
}), ci = () => ({
  typeId: b.Utf8,
  offsets: Lt
}), hi = (e, t, n = 128) => ({
  typeId: b.Decimal,
  precision: e,
  scale: t,
  bitWidth: It(n, [32, 64, 128, 256]),
  values: n === 32 ? Lt : as
}), ui = (e) => ({
  typeId: b.Date,
  unit: It(e, Ce),
  values: e === Ce.DAY ? Lt : _t
}), fi = (e = bt.MILLISECOND) => {
  e = It(e, bt);
  const t = e === bt.SECOND || e === bt.MILLISECOND ? 32 : 64;
  return {
    typeId: b.Time,
    unit: e,
    bitWidth: t,
    values: t === 32 ? Lt : _t
  };
}, di = (e = bt.MILLISECOND, t = null) => ({
  typeId: b.Timestamp,
  unit: It(e, bt),
  timezone: t,
  values: _t
}), pi = (e = ee.MONTH_DAY_NANO) => ({
  typeId: b.Interval,
  unit: It(e, ee),
  values: e === ee.MONTH_DAY_NANO ? void 0 : Lt
}), gi = (e) => ({
  typeId: b.List,
  children: [Ut(e)],
  offsets: Lt
}), mi = (e) => ({
  typeId: b.Struct,
  children: Array.isArray(e) && e.length > 0 && us(e[0]) ? (
    /** @type {Field[]} */
    e
  ) : Object.entries(e).map(([t, n]) => hs(t, n))
}), vi = (e, t, n, s) => (n ?? (n = t.map((i, r) => r)), {
  typeId: b.Union,
  mode: It(e, on),
  typeIds: n,
  typeMap: n.reduce((i, r, o) => (i[r] = o, i), {}),
  children: t.map((i, r) => Ut(i, `_${r}`)),
  typeIdForValue: s,
  offsets: Lt
}), yi = (e) => ({
  typeId: b.FixedSizeBinary,
  stride: e
}), bi = (e, t) => ({
  typeId: b.FixedSizeList,
  stride: t,
  children: [Ut(e)]
}), wi = (e, t) => ({
  typeId: b.Map,
  keysSorted: e,
  children: [t],
  offsets: Lt
}), Si = (e = bt.MILLISECOND) => ({
  typeId: b.Duration,
  unit: It(e, bt),
  values: _t
}), Mi = () => ({
  typeId: b.LargeBinary,
  offsets: _t
}), xi = () => ({
  typeId: b.LargeUtf8,
  offsets: _t
}), ki = (e) => ({
  typeId: b.LargeList,
  children: [Ut(e)],
  offsets: _t
}), Ai = (e, t) => ({
  typeId: b.RunEndEncoded,
  children: [
    ln(
      Ut(e, "run_ends"),
      (n) => n.type.typeId === b.Int,
      () => "Run-ends must have an integer type."
    ),
    Ut(t, "values")
  ]
}), Ti = (e) => ({
  typeId: b.ListView,
  children: [Ut(e, "value")],
  offsets: Lt
}), Li = (e) => ({
  typeId: b.LargeListView,
  children: [Ut(e, "value")],
  offsets: _t
}), Bi = new We(2), $i = Bi.buffer;
new _t($i);
function zt(e) {
  if (e > Number.MAX_SAFE_INTEGER || e < Number.MIN_SAFE_INTEGER)
    throw Error(`BigInt exceeds integer number representation: ${e}`);
  return Number(e);
}
function un(e, t) {
  return Number(e / t) + Number(e % t) / Number(t);
}
const Qt = (e) => BigInt.asUintN(64, e);
function Ri(e, t) {
  return BigInt.asIntN(64, e[t]);
}
function _i(e, t) {
  const n = t << 1;
  let s;
  return BigInt.asIntN(64, e[n + 1]) < 0 ? (s = Qt(~e[n]) | Qt(~e[n + 1]) << 64n, s = -(s + 1n)) : s = e[n] | e[n + 1] << 64n, s;
}
function Ii(e, t) {
  const n = t << 2;
  let s;
  return BigInt.asIntN(64, e[n + 3]) < 0 ? (s = Qt(~e[n]) | Qt(~e[n + 1]) << 64n | Qt(~e[n + 2]) << 128n | Qt(~e[n + 3]) << 192n, s = -(s + 1n)) : s = e[n] | e[n + 1] << 64n | e[n + 2] << 128n | e[n + 3] << 192n, s;
}
const Ei = new TextDecoder("utf-8");
new TextEncoder();
function He(e) {
  return Ei.decode(e);
}
const me = 4;
function gs(e, t) {
  return (e[t >> 3] & 1 << t % 8) !== 0;
}
function Et(e, t) {
  const n = t + Q(e, t), s = n - Q(e, n), i = At(e, s);
  return (r, o, a = null) => {
    if (r < i) {
      const l = At(e, s + r);
      if (l) return o(e, n + l);
    }
    return a;
  };
}
function ne(e, t) {
  return t;
}
function ve(e, t) {
  return !!Ze(e, t);
}
function Ze(e, t) {
  return fn(e, t) << 24 >> 24;
}
function fn(e, t) {
  return e[t];
}
function At(e, t) {
  return Ci(e, t) << 16 >> 16;
}
function Ci(e, t) {
  return e[t] | e[t + 1] << 8;
}
function Q(e, t) {
  return e[t] | e[t + 1] << 8 | e[t + 2] << 16 | e[t + 3] << 24;
}
function Sn(e, t) {
  return Q(e, t) >>> 0;
}
function St(e, t) {
  return zt(BigInt.asIntN(
    64,
    BigInt(Sn(e, t)) + (BigInt(Sn(e, t + me)) << 32n)
  ));
}
function De(e, t) {
  let n = t + Q(e, t);
  const s = Q(e, n);
  return n += me, He(e.subarray(n, n + s));
}
function Ht(e, t, n, s) {
  if (!t) return [];
  const i = t + Q(e, t);
  return Array.from(
    { length: Q(e, i) },
    (r, o) => s(e, i + me + o * n)
  );
}
const Ge = Symbol("rowIndex");
function Je(e, t) {
  class n {
    /**
     * Create a new proxy row object representing a struct or table row.
     * @param {number} index The record batch row index.
     */
    constructor(r) {
      this[Ge] = r;
    }
    /**
     * Return a JSON-compatible object representation.
     */
    toJSON() {
      return vs(e, t, this[Ge]);
    }
  }
  const s = n.prototype;
  for (let i = 0; i < e.length; ++i) {
    if (Object.hasOwn(s, e[i])) continue;
    const r = t[i];
    Object.defineProperty(s, e[i], {
      get() {
        return r.at(this[Ge]);
      },
      enumerable: !0
    });
  }
  return (i) => new n(i);
}
function ms(e, t) {
  return (n) => vs(e, t, n);
}
function vs(e, t, n) {
  const s = {};
  for (let i = 0; i < e.length; ++i)
    s[e[i]] = t[i].at(n);
  return s;
}
function Di(e) {
  return e instanceof Jt;
}
class we {
  /**
   * Create a new column batch.
   * @param {object} options
   * @param {number} options.length The length of the batch
   * @param {number} options.nullCount The null value count
   * @param {DataType} options.type The data type.
   * @param {Uint8Array} [options.validity] Validity bitmap buffer
   * @param {TypedArray} [options.values] Values buffer
   * @param {OffsetArray} [options.offsets] Offsets buffer
   * @param {OffsetArray} [options.sizes] Sizes buffer
   * @param {Batch[]} [options.children] Children batches
   */
  constructor({
    length: t,
    nullCount: n,
    type: s,
    validity: i,
    values: r,
    offsets: o,
    sizes: a,
    children: l
  }) {
    this.length = t, this.nullCount = n, this.type = s, this.validity = i, this.values = r, this.offsets = o, this.sizes = a, this.children = l, (!n || !this.validity) && (this.at = (c) => this.value(c));
  }
  /**
   * Provide an informative object string tag.
   */
  get [Symbol.toStringTag]() {
    return "Batch";
  }
  /**
   * Return the value at the given index.
   * @param {number} index The value index.
   * @returns {T | null} The value.
   */
  at(t) {
    return this.isValid(t) ? this.value(t) : null;
  }
  /**
   * Check if a value at the given index is valid (non-null).
   * @param {number} index The value index.
   * @returns {boolean} True if valid, false otherwise.
   */
  isValid(t) {
    return gs(this.validity, t);
  }
  /**
   * Return the value at the given index. This method does not check the
   * validity bitmap and is intended primarily for internal use. In most
   * cases, callers should use the `at()` method instead.
   * @param {number} index The value index
   * @returns {T} The value, ignoring the validity bitmap.
   */
  value(t) {
    return (
      /** @type {T} */
      this.values[t]
    );
  }
  /**
   * Extract an array of values within the given index range. Unlike
   * Array.slice, all arguments are required and may not be negative indices.
   * @param {number} start The starting index, inclusive
   * @param {number} end The ending index, exclusive
   * @returns {ValueArray<T?>} The slice of values
   */
  slice(t, n) {
    const s = n - t, i = Array(s);
    for (let r = 0; r < s; ++r)
      i[r] = this.at(t + r);
    return i;
  }
  /**
   * Return an iterator over the values in this batch.
   * @returns {Iterator<T?>}
   */
  *[Symbol.iterator]() {
    for (let t = 0; t < this.length; ++t)
      yield this.at(t);
  }
}
/**
 * The array type to use when extracting data from the batch.
 * A null value indicates that the array type should match
 * the type of the batch's values array.
 * @type {ArrayConstructor | TypedArrayConstructor | null}
 */
Xt(we, "ArrayType", null);
class Jt extends we {
  /**
   * Create a new column batch with direct value array access.
   * @param {object} options
   * @param {number} options.length The length of the batch
   * @param {number} options.nullCount The null value count
   * @param {DataType} options.type The data type.
   * @param {Uint8Array} [options.validity] Validity bitmap buffer
   * @param {TypedArray} options.values Values buffer
   */
  constructor(t) {
    super(t);
    const { length: n, values: s } = this;
    this.values = s.subarray(0, n);
  }
  /**
   * Extract an array of values within the given index range. Unlike
   * Array.slice, all arguments are required and may not be negative indices.
   * When feasible, a zero-copy subarray of a typed array is returned.
   * @param {number} start The starting index, inclusive
   * @param {number} end The ending index, exclusive
   * @returns {ValueArray<T?>} The slice of values
   */
  slice(t, n) {
    return this.nullCount ? super.slice(t, n) : this.values.subarray(t, n);
  }
  /**
   * Return an iterator over the values in this batch.
   * @returns {Iterator<T?>}
   */
  [Symbol.iterator]() {
    return this.nullCount ? super[Symbol.iterator]() : (
      /** @type {Iterator<T?>} */
      this.values[Symbol.iterator]()
    );
  }
}
class Se extends we {
}
Xt(Se, "ArrayType", We);
class st extends we {
}
Xt(st, "ArrayType", Array);
class Fi extends st {
  /**
   * @param {number} index The value index
   * @returns {null}
   */
  value(t) {
    return null;
  }
}
class se extends Se {
  /**
   * @param {number} index The value index
   */
  value(t) {
    return zt(
      /** @type {bigint} */
      this.values[t]
    );
  }
}
class Ni extends Se {
  /**
   * @param {number} index The value index
   */
  value(t) {
    const n = (
      /** @type {number} */
      this.values[t]
    ), s = (n & 31744) >> 10, i = (n & 1023) / 1024, r = (-1) ** ((n & 32768) >> 15);
    switch (s) {
      case 31:
        return r * (i ? Number.NaN : 1 / 0);
      case 0:
        return r * (i ? 6103515625e-14 * i : 0);
    }
    return r * 2 ** (s - 15) * (1 + i);
  }
}
class Oi extends st {
  /**
   * @param {number} index The value index
   */
  value(t) {
    return gs(
      /** @type {Uint8Array} */
      this.values,
      t
    );
  }
}
class Pi extends Se {
  constructor(t) {
    super(t);
    const { scale: n } = (
      /** @type {DecimalType} */
      this.type
    );
    this.scale = 10 ** n;
  }
  /**
   * @param {number} index The value index
   */
  value(t) {
    return (
      /** @type {number} */
      this.values[t] / this.scale
    );
  }
}
class ys extends we {
  constructor(t) {
    super(t);
    const { bitWidth: n, scale: s } = (
      /** @type {DecimalType} */
      this.type
    );
    this.decimal = n === 64 ? Ri : n === 128 ? _i : Ii, this.scale = 10n ** BigInt(s);
  }
}
class bs extends ys {
  /**
   * @param {number} index The value index
   */
  value(t) {
    return un(
      this.decimal(
        /** @type {BigUint64Array} */
        this.values,
        t
      ),
      this.scale
    );
  }
}
Xt(bs, "ArrayType", We);
class ws extends ys {
  /**
   * @param {number} index The value index
   */
  value(t) {
    return this.decimal(
      /** @type {BigUint64Array} */
      this.values,
      t
    );
  }
}
Xt(ws, "ArrayType", Array);
class Mn extends st {
  /**
   * Create a new date batch.
   * @param {Batch<number>} batch A batch of timestamp values.
   */
  constructor(t) {
    super(t), this.source = t;
  }
  /**
   * @param {number} index The value index
   */
  value(t) {
    return new Date(this.source.value(t));
  }
}
class Wi extends Se {
  /**
   * @param {number} index The value index
   * @returns {number}
   */
  value(t) {
    return 864e5 * /** @type {number} */
    this.values[t];
  }
}
const Hi = se;
class Ui extends se {
  /**
   * @param {number} index The value index
   */
  value(t) {
    return super.value(t) * 1e3;
  }
}
const zi = se;
class Gi extends se {
  /**
   * @param {number} index The value index
   */
  value(t) {
    return un(
      /** @type {bigint} */
      this.values[t],
      1000n
    );
  }
}
class Vi extends se {
  /**
   * @param {number} index The value index
   */
  value(t) {
    return un(
      /** @type {bigint} */
      this.values[t],
      1000000n
    );
  }
}
class Yi extends st {
  /**
   * @param {number} index The value index
   * @returns {Int32Array}
   */
  value(t) {
    return /** @type {Int32Array} */ this.values.subarray(t << 1, t + 1 << 1);
  }
}
class Xi extends st {
  /**
   * @param {number} index The value index
   */
  value(t) {
    const n = (
      /** @type {Uint8Array} */
      this.values
    ), s = t << 4;
    return Float64Array.of(
      Q(n, s),
      Q(n, s + 4),
      St(n, s + 8)
    );
  }
}
const Ss = ({ values: e, offsets: t }, n) => e.subarray(t[n], t[n + 1]), Ms = ({ values: e, offsets: t }, n) => e.subarray(zt(t[n]), zt(t[n + 1]));
class Ki extends st {
  /**
   * @param {number} index
   * @returns {Uint8Array}
   */
  value(t) {
    return Ss(this, t);
  }
}
class ji extends st {
  /**
   * @param {number} index
   * @returns {Uint8Array}
   */
  value(t) {
    return Ms(this, t);
  }
}
class qi extends st {
  /**
   * @param {number} index
   */
  value(t) {
    return He(Ss(this, t));
  }
}
class Zi extends st {
  /**
   * @param {number} index
   */
  value(t) {
    return He(Ms(this, t));
  }
}
class Ji extends st {
  /**
   * @param {number} index
   * @returns {ValueArray<V>}
   */
  value(t) {
    const n = (
      /** @type {Int32Array} */
      this.offsets
    );
    return this.children[0].slice(n[t], n[t + 1]);
  }
}
class Qi extends st {
  /**
   * @param {number} index
   * @returns {ValueArray<V>}
   */
  value(t) {
    const n = (
      /** @type {BigInt64Array} */
      this.offsets
    );
    return this.children[0].slice(zt(n[t]), zt(n[t + 1]));
  }
}
class tr extends st {
  /**
   * @param {number} index
   * @returns {ValueArray<V>}
   */
  value(t) {
    const n = (
      /** @type {number} */
      this.offsets[t]
    ), s = n + /** @type {number} */
    this.sizes[t];
    return this.children[0].slice(n, s);
  }
}
class er extends st {
  /**
   * @param {number} index
   * @returns {ValueArray<V>}
   */
  value(t) {
    const n = (
      /** @type {bigint} */
      this.offsets[t]
    ), s = n + /** @type {bigint} */
    this.sizes[t];
    return this.children[0].slice(zt(n), zt(s));
  }
}
class xs extends st {
  constructor(t) {
    super(t), this.stride = this.type.stride;
  }
}
class nr extends xs {
  /**
   * @param {number} index
   * @returns {Uint8Array}
   */
  value(t) {
    const { stride: n, values: s } = this;
    return (
      /** @type {Uint8Array} */
      s.subarray(t * n, (t + 1) * n)
    );
  }
}
class sr extends xs {
  /**
   * @param {number} index
   * @returns {ValueArray<V>}
   */
  value(t) {
    const { children: n, stride: s } = this;
    return n[0].slice(t * s, (t + 1) * s);
  }
}
function ks({ children: e, offsets: t }, n) {
  const [s, i] = e[0].children, r = t[n], o = t[n + 1], a = [];
  for (let l = r; l < o; ++l)
    a.push([s.at(l), i.at(l)]);
  return a;
}
class ir extends st {
  /**
   * Return the value at the given index.
   * @param {number} index The value index.
   * @returns {[K, V][]} The map entries as an array of [key, value] arrays.
   */
  value(t) {
    return (
      /** @type {[K, V][]} */
      ks(this, t)
    );
  }
}
class rr extends st {
  /**
   * Return the value at the given index.
   * @param {number} index The value index.
   * @returns {Map<K, V>} The map value.
   */
  value(t) {
    return new Map(
      /** @type {[K, V][]} */
      ks(this, t)
    );
  }
}
class As extends st {
  /**
   * Create a new column batch.
   * @param {object} options
   * @param {number} options.length The length of the batch
   * @param {number} options.nullCount The null value count
   * @param {DataType} options.type The data type.
   * @param {Uint8Array} [options.validity] Validity bitmap buffer
   * @param {Int32Array} [options.offsets] Offsets buffer
   * @param {Batch[]} options.children Children batches
   * @param {Int8Array} options.typeIds Union type ids buffer
   * @param {Record<string, number>} options.map A typeId to children index map
   */
  constructor({ typeIds: t, ...n }) {
    super(n), this.typeIds = t, this.typeMap = this.type.typeMap;
  }
  /**
   * @param {number} index The value index.
   */
  value(t, n = t) {
    const { typeIds: s, children: i, typeMap: r } = this;
    return i[r[s[t]]].at(n);
  }
}
class or extends As {
  /**
   * @param {number} index The value index.
   */
  value(t) {
    return super.value(
      t,
      /** @type {number} */
      this.offsets[t]
    );
  }
}
class Ts extends st {
  constructor(t, n = ms) {
    super(t), this.names = this.type.children.map((s) => s.name), this.factory = n(this.names, this.children);
  }
  /**
   * @param {number} index The value index.
   * @returns {Record<string, any>}
   */
  value(t) {
    return this.factory(t);
  }
}
class ar extends Ts {
  constructor(t) {
    super(t, Je);
  }
}
class lr extends st {
  /**
   * @param {number} index The value index.
   */
  value(t) {
    const [{ values: n }, s] = this.children;
    return s.at(
      an(
        /** @type {IntegerArray} */
        n,
        t
      )
    );
  }
}
class cr extends st {
  /**
   * Register the backing dictionary. Dictionaries are added
   * after batch creation as the complete dictionary may not
   * be finished across multiple record batches.
   * @param {Column<T>} dictionary
   * The dictionary of column values.
   */
  setDictionary(t) {
    return this.dictionary = t, this.cache = t.cache(), this;
  }
  /**
   * @param {number} index The value index.
   */
  value(t) {
    return this.cache[this.key(t)];
  }
  /**
   * @param {number} index The value index.
   * @returns {number} The dictionary key
   */
  key(t) {
    return (
      /** @type {number} */
      this.values[t]
    );
  }
}
class Ls extends st {
  /**
   * Create a new view batch.
   * @param {object} options Batch options.
   * @param {number} options.length The length of the batch
   * @param {number} options.nullCount The null value count
   * @param {DataType} options.type The data type.
   * @param {Uint8Array} [options.validity] Validity bitmap buffer
   * @param {Uint8Array} options.values Values buffer
   * @param {Uint8Array[]} options.data View data buffers
   */
  constructor({ data: t, ...n }) {
    super(n), this.data = t;
  }
  /**
   * Get the binary data at the provided index.
   * @param {number} index The value index.
   * @returns {Uint8Array}
   */
  view(t) {
    const { values: n, data: s } = this, i = t << 4;
    let r = i + 4, o = (
      /** @type {Uint8Array} */
      n
    );
    const a = Q(o, i);
    return a > 12 && (r = Q(o, i + 12), o = s[Q(o, i + 8)]), o.subarray(r, r + a);
  }
}
class hr extends Ls {
  /**
   * @param {number} index The value index.
   */
  value(t) {
    return this.view(t);
  }
}
class ur extends Ls {
  /**
   * @param {number} index The value index.
   */
  value(t) {
    return He(this.view(t));
  }
}
function fr(e) {
  let t = [];
  return {
    add(n) {
      return t.push(n), this;
    },
    clear: () => t = [],
    done: () => new Le(t, e)
  };
}
class Le {
  /**
   * Create a new column instance.
   * @param {Batch<T>[]} data The value batches.
   * @param {DataType} [type] The column data type.
   *  If not specified, the type is extracted from the batches.
   */
  constructor(t, n = t[0]?.type) {
    this.type = n, this.length = t.reduce((r, o) => r + o.length, 0), this.nullCount = t.reduce((r, o) => r + o.nullCount, 0), this.data = t;
    const s = t.length, i = new Int32Array(s + 1);
    if (s === 1) {
      const [r] = t;
      i[1] = r.length, this.at = (o) => r.at(o);
    } else
      for (let r = 0, o = 0; r < s; ++r)
        i[r + 1] = o += t[r].length;
    this.offsets = i;
  }
  /**
   * Provide an informative object string tag.
   */
  get [Symbol.toStringTag]() {
    return "Column";
  }
  /**
   * Return an iterator over the values in this column.
   * @returns {Iterator<T?>}
   */
  [Symbol.iterator]() {
    const t = this.data;
    return t.length === 1 ? t[0][Symbol.iterator]() : dr(t);
  }
  /**
   * Return the column value at the given index. If a column has multiple
   * batches, this method performs binary search over the batch lengths to
   * determine the batch from which to retrieve the value. The search makes
   * lookup less efficient than a standard array access. If making a full
   * scan of a column, consider extracting arrays via `toArray()` or using an
   * iterator (`for (const value of column) {...}`).
   * @param {number} index The row index.
   * @returns {T | null} The value.
   */
  at(t) {
    const { data: n, offsets: s } = this, i = an(s, t) - 1;
    return n[i]?.at(t - s[i]);
  }
  /**
   * Return the column value at the given index. This method is the same as
   * `at()` and is provided for better compatibility with Apache Arrow JS.
   * @param {number} index The row index.
   * @returns {T | null} The value.
   */
  get(t) {
    return this.at(t);
  }
  /**
   * Extract column values into a single array instance. When possible,
   * a zero-copy subarray of the input Arrow data is returned.
   * @returns {ValueArray<T?>}
   */
  toArray() {
    const { length: t, nullCount: n, data: s } = this, i = !n && Di(s[0]), r = s.length;
    if (i && r === 1)
      return s[0].values;
    const o = !r || n > 0 ? Array : s[0].constructor.ArrayType ?? s[0].values.constructor, a = new o(t);
    return i ? pr(a, s) : gr(a, s);
  }
  /**
   * Return an array of cached column values.
   * Used internally to accelerate dictionary types.
   */
  cache() {
    return this._cache ?? (this._cache = this.toArray());
  }
}
function* dr(e) {
  for (let t = 0; t < e.length; ++t) {
    const n = e[t][Symbol.iterator]();
    for (let s = n.next(); !s.done; s = n.next())
      yield s.value;
  }
}
function pr(e, t) {
  for (let n = 0, s = 0; n < t.length; ++n) {
    const { values: i } = t[n];
    e.set(i, s), s += i.length;
  }
  return e;
}
function gr(e, t) {
  let n = -1;
  for (let s = 0; s < t.length; ++s) {
    const i = t[s];
    for (let r = 0; r < i.length; ++r)
      e[++n] = i.at(r);
  }
  return e;
}
class dn {
  /**
   * Create a new table with the given schema and columns (children).
   * @param {Schema} schema The table schema.
   * @param {Column[]} children The table columns.
   * @param {boolean} [useProxy=false] Flag indicating if row proxy
   *  objects should be used to represent table rows (default `false`).
   */
  constructor(t, n, s = !1) {
    const i = t.fields.map((o) => o.name);
    this.schema = t, this.names = i, this.children = n, this.factory = s ? Je : ms;
    const r = [];
    this.getFactory = (o) => r[o] ?? (r[o] = this.factory(i, n.map((a) => a.data[o])));
  }
  /**
   * Provide an informative object string tag.
   */
  get [Symbol.toStringTag]() {
    return "Table";
  }
  /**
   * The number of columns in this table.
   * @return {number} The number of columns.
   */
  get numCols() {
    return this.names.length;
  }
  /**
   * The number of rows in this table.
   * @return {number} The number of rows.
   */
  get numRows() {
    return this.children[0]?.length ?? 0;
  }
  /**
   * Return the child column at the given index position.
   * @template {T[keyof T]} R
   * @param {number} index The column index.
   * @returns {Column<R>}
   */
  getChildAt(t) {
    return this.children[t];
  }
  /**
   * Return the first child column with the given name.
   * @template {keyof T} P
   * @param {P} name The column name.
   * @returns {Column<T[P]>}
   */
  getChild(t) {
    const n = this.names.findIndex((s) => s === t);
    return n > -1 ? this.children[n] : void 0;
  }
  /**
   * Construct a new table containing only columns at the specified indices.
   * The order of columns in the new table matches the order of input indices.
   * @template {T[keyof T]} V
   * @param {number[]} indices The indices of columns to keep.
   * @param {string[]} [as] Optional new names for selected columns.
   * @returns {Table<{ [key: string]: V }>} A new table with selected columns.
   */
  selectAt(t, n = []) {
    const { children: s, factory: i, schema: r } = this, { fields: o } = r;
    return new dn(
      {
        ...r,
        fields: t.map((a, l) => mr(o[a], n[l]))
      },
      t.map((a) => s[a]),
      i === Je
    );
  }
  /**
   * Construct a new table containing only columns with the specified names.
   * If columns have duplicate names, the first (with lowest index) is used.
   * The order of columns in the new table matches the order of input names.
   * @template {keyof T} K
   * @param {K[]} names Names of columns to keep.
   * @param {string[]} [as] Optional new names for selected columns.
   * @returns A new table with columns matching the specified names.
   */
  select(t, n) {
    const s = (
      /** @type {K[]} */
      this.names
    ), i = t.map((r) => s.indexOf(r));
    return this.selectAt(i, n);
  }
  /**
   * Return an object mapping column names to extracted value arrays.
   * @returns {{ [P in keyof T]: ValueArray<T[P]> }}
   */
  toColumns() {
    const { children: t, names: n } = this, s = {};
    return n.forEach((i, r) => s[i] = t[r]?.toArray() ?? []), s;
  }
  /**
   * Return an array of objects representing the rows of this table.
   * @returns {{ [P in keyof T]: T[P] }[]}
   */
  toArray() {
    const { children: t, getFactory: n, numRows: s } = this, i = t[0]?.data ?? [], r = Array(s);
    for (let o = 0, a = -1; o < i.length; ++o) {
      const l = n(o);
      for (let c = 0; c < i[o].length; ++c)
        r[++a] = l(c);
    }
    return r;
  }
  /**
   * Return an iterator over objects representing the rows of this table.
   * @returns {Generator<{ [P in keyof T]: T[P] }, any, any>}
   */
  *[Symbol.iterator]() {
    const { children: t, getFactory: n } = this, s = t[0]?.data ?? [];
    for (let i = 0; i < s.length; ++i) {
      const r = n(i);
      for (let o = 0; o < s[i].length; ++o)
        yield r(o);
    }
  }
  /**
   * Return a row object for the given index.
   * @param {number} index The row index.
   * @returns {{ [P in keyof T]: T[P] }} The row object.
   */
  at(t) {
    const { children: n, getFactory: s, numRows: i } = this;
    if (t < 0 || t >= i) return null;
    const [{ offsets: r }] = n, o = an(r, t) - 1;
    return s(o)(t - r[o]);
  }
  /**
   * Return a row object for the given index. This method is the same as
   * `at()` and is provided for better compatibility with Apache Arrow JS.
   * @param {number} index The row index.
   * @returns {{ [P in keyof T]: T[P] }} The row object.
   */
  get(t) {
    return this.at(t);
  }
}
function mr(e, t) {
  return t != null && t !== e.name ? { ...e, name: t } : e;
}
function vr(e, t = {}) {
  const { typeId: n, bitWidth: s, mode: i, precision: r, unit: o } = (
    /** @type {any} */
    e
  ), { useBigInt: a, useBigIntTimestamp: l, useDate: c, useDecimalInt: u, useMap: h, useProxy: v } = t;
  switch (n) {
    case b.Null:
      return Fi;
    case b.Bool:
      return Oi;
    case b.Int:
    case b.Time:
    case b.Duration:
      return a || s < 64 ? Jt : se;
    case b.Float:
      return r ? Jt : Ni;
    case b.Date:
      return xn(
        o === Ce.DAY ? Wi : Hi,
        c && Mn
      );
    case b.Timestamp:
      return l ? Jt : xn(
        o === bt.SECOND ? Ui : o === bt.MILLISECOND ? zi : o === bt.MICROSECOND ? Gi : Vi,
        c && Mn
      );
    case b.Decimal:
      return s === 32 ? u ? Jt : Pi : u ? ws : bs;
    case b.Interval:
      return o === ee.DAY_TIME ? Yi : o === ee.YEAR_MONTH ? Jt : Xi;
    case b.FixedSizeBinary:
      return nr;
    case b.Utf8:
      return qi;
    case b.LargeUtf8:
      return Zi;
    case b.Binary:
      return Ki;
    case b.LargeBinary:
      return ji;
    case b.BinaryView:
      return hr;
    case b.Utf8View:
      return ur;
    case b.List:
      return Ji;
    case b.LargeList:
      return Qi;
    case b.Map:
      return h ? rr : ir;
    case b.ListView:
      return tr;
    case b.LargeListView:
      return er;
    case b.FixedSizeList:
      return sr;
    case b.Struct:
      return v ? ar : Ts;
    case b.RunEndEncoded:
      return lr;
    case b.Dictionary:
      return cr;
    case b.Union:
      return i ? or : As;
  }
  throw new Error(hn(n));
}
function xn(e, t) {
  return t ? class extends t {
    constructor(s) {
      super(new e(s));
    }
  } : e;
}
const yr = -1, br = 8;
function wr(e) {
  return `Missing compression codec "${cn(is, e)}" (id ${e})`;
}
const Sr = /* @__PURE__ */ new Map();
function Mr(e) {
  return e != null && Sr.get(e) || null;
}
function xr(e, { offset: t, length: n }, s) {
  if (n === 0)
    return { bytes: new Uint8Array(0), offset: 0, length: 0 };
  const i = St(e, t), r = e.subarray(t + br, t + n), o = i === yr ? r : s.decode(r, i);
  return { bytes: o, offset: 0, length: o.length };
}
function kr(e, t) {
  return {
    offset: St(e, t),
    metadataLength: Q(e, t + 8),
    bodyLength: St(e, t + 16)
  };
}
function kn(e, t) {
  return Ht(e, t, 24, kr);
}
function Ar(e, t) {
  const n = Et(e, t);
  return {
    codec: (
      /** @type {CompressionType_} */
      n(4, Ze, is.LZ4_FRAME)
    ),
    method: (
      /** @type {BodyCompressionMethod_} */
      n(6, Ze, rs.BUFFER)
    )
  };
}
function Bs(e, t, n) {
  const s = Et(e, t), i = n < Pe.V4 ? 8 : 0;
  return {
    length: s(4, St, 0),
    nodes: Ht(e, s(6, ne), 16, (r, o) => ({
      length: St(r, o),
      nullCount: St(r, o + 8)
    })),
    regions: Ht(e, s(8, ne), 16 + i, (r, o) => ({
      offset: St(r, o + i),
      length: St(r, o + i + 8)
    })),
    compression: s(10, Ar),
    variadic: Ht(e, s(12, ne), 8, St)
  };
}
function Tr(e, t, n) {
  const s = Et(e, t);
  return {
    id: s(4, St, 0),
    data: s(6, (i, r) => Bs(i, r, n)),
    /**
     * If isDelta is true the values in the dictionary are to be appended to a
     * dictionary with the indicated id. If isDelta is false this dictionary
     * should replace the existing dictionary.
     */
    isDelta: s(8, ve, !1)
  };
}
function $s(e, t, n, s) {
  It(n, b, hn);
  const i = Et(e, t);
  switch (n) {
    case b.Binary:
      return li();
    case b.Utf8:
      return ci();
    case b.LargeBinary:
      return Mi();
    case b.LargeUtf8:
      return xi();
    case b.List:
      return gi(s[0]);
    case b.ListView:
      return Ti(s[0]);
    case b.LargeList:
      return ki(s[0]);
    case b.LargeListView:
      return Li(s[0]);
    case b.Struct:
      return mi(s);
    case b.RunEndEncoded:
      return Ai(s[0], s[1]);
    case b.Int:
      return ds(
        // @ts-ignore
        i(4, Q, 0),
        // bitwidth
        i(6, ve, !1)
        // signed
      );
    case b.Float:
      return ai(
        // @ts-ignore
        i(4, At, ss.HALF)
        // precision
      );
    case b.Decimal:
      return hi(
        i(4, Q, 0),
        // precision
        i(6, Q, 0),
        // scale
        // @ts-ignore
        i(8, Q, 128)
        // bitwidth
      );
    case b.Date:
      return ui(
        // @ts-ignore
        i(4, At, Ce.MILLISECOND)
        // unit
      );
    case b.Time:
      return fi(
        // @ts-ignore
        i(4, At, bt.MILLISECOND)
        // unit
      );
    case b.Timestamp:
      return di(
        // @ts-ignore
        i(4, At, bt.SECOND),
        // unit
        i(6, De)
        // timezone
      );
    case b.Interval:
      return pi(
        // @ts-ignore
        i(4, At, ee.YEAR_MONTH)
        // unit
      );
    case b.Duration:
      return Si(
        // @ts-ignore
        i(4, At, bt.MILLISECOND)
        // unit
      );
    case b.FixedSizeBinary:
      return yi(
        i(4, Q, 0)
        // stride
      );
    case b.FixedSizeList:
      return bi(
        s[0],
        i(4, Q, 0)
        // stride
      );
    case b.Map:
      return wi(
        i(4, ve, !1),
        // keysSorted
        s[0]
      );
    case b.Union:
      return vi(
        // @ts-ignore
        i(4, At, on.Sparse),
        // mode
        s,
        Ht(e, i(6, ne), 4, Q)
        // type ids
      );
  }
  return { typeId: n };
}
function pn(e, t) {
  const n = Ht(e, t, 4, (s, i) => {
    const r = Et(s, i);
    return (
      /** @type {[string, string]} */
      [
        r(4, De),
        // 4: key (string)
        r(6, De)
        // 6: key (string)
      ]
    );
  });
  return n.length ? new Map(n) : null;
}
function Rs(e, t, n) {
  const s = Et(e, t);
  return {
    version: n,
    endianness: (
      /** @type {Endianness_} */
      s(4, At, 0)
    ),
    fields: s(6, Lr, []),
    metadata: s(8, pn)
  };
}
function Lr(e, t) {
  return Ht(e, t, 4, _s);
}
function _s(e, t) {
  const n = Et(e, t), s = n(8, fn, b.NONE), i = n(10, ne, 0), r = n(12, $r), o = n(14, Br, []);
  let a = $s(e, i, s, o);
  return r && (r.dictionary = a, a = r), {
    name: n(4, De),
    type: a,
    nullable: n(6, ve, !1),
    metadata: n(16, pn)
  };
}
function Br(e, t) {
  return Ht(e, t, 4, _s);
}
function $r(e, t) {
  if (!t) return null;
  const n = Et(e, t);
  return oi(
    null,
    // data type will be populated by caller
    n(6, Rr, ps()),
    // index type
    n(8, ve, !1),
    // ordered
    n(4, St, 0)
    // id
  );
}
function Rr(e, t) {
  return (
    /** @type {IntType} */
    $s(e, t, b.Int)
  );
}
const _r = (e, t) => `Expected to read ${e} metadata bytes, but only read ${t}.`, Ir = (e, t) => `Expected to read ${e} bytes for message body, but only read ${t}.`, Er = (e) => `Unsupported message type: ${e} (${cn(Ft, e)})`;
function Qe(e, t) {
  let n = Q(e, t) || 0;
  if (t += me, n === -1 && (n = Q(e, t) || 0, t += me), n === 0) return null;
  const s = e.subarray(t, t += n);
  if (s.byteLength < n)
    throw new Error(_r(n, s.byteLength));
  const i = Et(s, 0), r = (
    /** @type {Version_} */
    i(4, At, Pe.V1)
  ), o = (
    /** @type {MessageHeader_} */
    i(6, fn, Ft.NONE)
  ), a = i(8, ne, 0), l = i(10, St, 0);
  let c;
  if (a) {
    const u = o === Ft.Schema ? Rs : o === Ft.DictionaryBatch ? Tr : o === Ft.RecordBatch ? Bs : null;
    if (!u) throw new Error(Er(o));
    if (c = u(s, a, r), l > 0) {
      const h = e.subarray(t, t += l);
      if (h.byteLength < l)
        throw new Error(Ir(l, h.byteLength));
      c.body = h;
    } else o !== Ft.Schema && (c.body = new Uint8Array(0));
  }
  return { version: r, type: o, index: t, content: c };
}
function Cr(e) {
  const t = ii(e) ? new Uint8Array(e) : e;
  return cs(t) && Dr(t) ? Nr(t) : Fr(t);
}
function Dr(e) {
  if (!e || e.length < 4) return !1;
  for (let t = 0; t < 6; ++t)
    if (ns[t] !== e[t]) return !1;
  return !0;
}
function Fr(e) {
  const t = [e].flat();
  let n;
  const s = [], i = [], r = [];
  for (const o of t) {
    if (!cs(o))
      throw new Error("IPC data batch was not a Uint8Array.");
    let a = 0;
    for (; ; ) {
      const l = Qe(o, a);
      if (l === null) break;
      if (a = l.index, !!l.content)
        switch (l.type) {
          case Ft.Schema:
            n || (n = l.content);
            break;
          case Ft.RecordBatch:
            s.push(l.content), r.push(i.length);
            break;
          case Ft.DictionaryBatch:
            i.push(l.content);
            break;
        }
    }
  }
  return (
    /** @type {ArrowData} */
    { schema: n, dictionaries: i, records: s, dictsBeforeRecord: r, metadata: null }
  );
}
function Nr(e) {
  const t = e.byteLength - (ns.length + 4), n = Q(e, t), s = Et(e, t - n), i = (
    /** @type {Version_} */
    s(4, At, Pe.V1)
  ), r = s(8, kn, []), o = s(10, kn, []), a = o.map(
    (l) => r.filter((c) => c.offset < l.offset).length
  );
  return (
    /** @type {ArrowData} */
    {
      schema: s(6, (l, c) => Rs(l, c, i)),
      dictionaries: r.map(({ offset: l }) => Qe(e, l).content),
      records: o.map(({ offset: l }) => Qe(e, l).content),
      dictsBeforeRecord: a,
      metadata: s(12, pn)
    }
  );
}
function gn(e, t) {
  return Or(Cr(e), t);
}
function Or(e, t = {}) {
  const { schema: n = { fields: [] }, dictionaries: s, records: i, dictsBeforeRecord: r } = e, { version: o, fields: a } = n, l = /* @__PURE__ */ new Map(), c = Wr(t, o, l), u = /* @__PURE__ */ new Map();
  Pr(n, (p) => {
    const m = p.type;
    m.typeId === b.Dictionary && u.set(m.id, m.dictionary);
  });
  const h = (p) => {
    const { id: m, data: k, isDelta: E, body: x } = p, y = u.get(m), R = tn(y, c({ ...k, body: x })), T = l.get(m);
    if (T)
      E ? l.set(m, new Le([...T.data, R], y)) : l.set(m, new Le([R], y));
    else {
      if (E)
        throw new Error("Delta update can not be first dictionary batch.");
      l.set(m, new Le([R], y));
    }
  }, v = a.map((p) => fr(p.type));
  let g = 0;
  for (let p = 0; p < i.length; p++) {
    const m = r ? r[p] : s.length;
    for (; g < m; )
      h(s[g++]);
    const k = c(i[p]);
    a.forEach((E, x) => v[x].add(tn(E.type, k)));
  }
  for (; g < s.length; )
    h(s[g++]);
  return new dn(n, v.map((p) => p.done()), t.useProxy);
}
function Pr(e, t) {
  e.fields.forEach(function n(s) {
    t(s), s.type.dictionary?.children?.forEach(n), s.type.children?.forEach(n);
  });
}
function Wr(e, t, n) {
  const s = {
    version: t,
    options: e,
    dictionary: (i) => n.get(i)
  };
  return (i) => {
    const { length: r, nodes: o, regions: a, compression: l, variadic: c, body: u } = i;
    let h = -1, v = -1, g = -1;
    return {
      ...s,
      length: r,
      node: () => o[++h],
      buffer: (p) => {
        const { bytes: m, length: k, offset: E } = Hr(u, a[++v], l);
        return p ? new p(m.buffer, m.byteOffset + E, k / p.BYTES_PER_ELEMENT) : m.subarray(E, E + k);
      },
      variadic: () => c[++g],
      visit(p) {
        return p.map((m) => tn(m.type, this));
      }
    };
  };
}
function Hr(e, t, n) {
  if (n) {
    if (n.method !== rs.BUFFER)
      throw new Error(`Unknown compression method (${n.method})`);
    {
      const s = n.codec, i = Mr(s);
      if (!i) throw new Error(wr(s));
      return xr(e, t, i);
    }
  } else return { bytes: e, ...t };
}
function tn(e, t) {
  const { typeId: n } = e, { options: s, node: i, buffer: r, variadic: o, version: a } = t, l = vr(e, s), c = { ...i(), type: e };
  if (n === b.Null)
    return new l({ ...c, nullCount: c.length });
  switch (n) {
    case b.Bool:
    case b.Int:
    case b.Time:
    case b.Duration:
    case b.Float:
    case b.Decimal:
    case b.Date:
    case b.Timestamp:
    case b.Interval:
    case b.FixedSizeBinary:
      return new l({
        ...c,
        validity: r(),
        values: r(e.values)
      });
    case b.Utf8:
    case b.LargeUtf8:
    case b.Binary:
    case b.LargeBinary:
      return new l({
        ...c,
        validity: r(),
        offsets: r(e.offsets),
        values: r()
      });
    case b.BinaryView:
    case b.Utf8View:
      return new l({
        ...c,
        validity: r(),
        values: r(),
        // views buffer
        data: Array.from({ length: o() }, () => r())
        // data buffers
      });
    case b.List:
    case b.LargeList:
    case b.Map:
      return new l({
        ...c,
        validity: r(),
        offsets: r(e.offsets),
        children: t.visit(e.children)
      });
    case b.ListView:
    case b.LargeListView:
      return new l({
        ...c,
        validity: r(),
        offsets: r(e.offsets),
        sizes: r(e.offsets),
        children: t.visit(e.children)
      });
    case b.FixedSizeList:
    case b.Struct:
      return new l({
        ...c,
        validity: r(),
        children: t.visit(e.children)
      });
    case b.RunEndEncoded:
      return new l({
        ...c,
        children: t.visit(e.children)
      });
    case b.Dictionary: {
      const { id: u, indices: h } = e;
      return new l({
        ...c,
        validity: r(),
        values: r(h.values)
      }).setDictionary(t.dictionary(u));
    }
    case b.Union:
      return a < Pe.V5 && r(), new l({
        ...c,
        typeIds: r(ls),
        offsets: e.mode === on.Sparse ? null : r(e.offsets),
        children: t.visit(e.children)
      });
    default:
      throw new Error(hn(n));
  }
}
new Uint16Array(new Uint8Array([1, 0]).buffer)[0];
var Ur = ArrayBuffer, at = Uint8Array, Fe = Uint16Array, zr = Int16Array, Ue = Int32Array, Ve = function(e, t, n) {
  if (at.prototype.slice)
    return at.prototype.slice.call(e, t, n);
  (t == null || t < 0) && (t = 0), (n == null || n > e.length) && (n = e.length);
  var s = new at(n - t);
  return s.set(e.subarray(t, n)), s;
}, fe = function(e, t, n, s) {
  if (at.prototype.fill)
    return at.prototype.fill.call(e, t, n, s);
  for ((n == null || n < 0) && (n = 0), (s == null || s > e.length) && (s = e.length); n < s; ++n)
    e[n] = t;
  return e;
}, Gr = function(e, t, n, s) {
  if (at.prototype.copyWithin)
    return at.prototype.copyWithin.call(e, t, n, s);
  for ((n == null || n < 0) && (n = 0), (s == null || s > e.length) && (s = e.length); n < s; )
    e[t++] = e[n++];
}, Vr = [
  "invalid zstd data",
  "window size too large (>2046MB)",
  "invalid block type",
  "FSE accuracy too high",
  "match distance too far back",
  "unexpected EOF"
], ct = function(e, t, n) {
  var s = new Error(t || Vr[e]);
  if (s.code = e, Error.captureStackTrace && Error.captureStackTrace(s, ct), !n)
    throw s;
  return s;
}, An = function(e, t, n) {
  for (var s = 0, i = 0; s < n; ++s)
    i |= e[t++] << (s << 3);
  return i;
}, Yr = function(e, t) {
  return (e[t] | e[t + 1] << 8 | e[t + 2] << 16 | e[t + 3] << 24) >>> 0;
}, Xr = function(e, t) {
  var n = e[0] | e[1] << 8 | e[2] << 16;
  if (n == 3126568 && e[3] == 253) {
    var s = e[4], i = s >> 5 & 1, r = s >> 2 & 1, o = s & 3, a = s >> 6;
    s & 8 && ct(0);
    var l = 6 - i, c = o == 3 ? 4 : o, u = An(e, l, c);
    l += c;
    var h = a ? 1 << a : i, v = An(e, l, h) + (a == 1 && 256), g = v;
    if (!i) {
      var p = 1 << 10 + (e[5] >> 3);
      g = p + (p >> 3) * (e[5] & 7);
    }
    g > 2145386496 && ct(1);
    var m = new at((t == 1 ? v || g : t ? 0 : g) + 12);
    return m[0] = 1, m[4] = 4, m[8] = 8, {
      b: l + h,
      y: 0,
      l: 0,
      d: u,
      w: t && t != 1 ? t : m.subarray(12),
      e: g,
      o: new Ue(m.buffer, 0, 3),
      u: v,
      c: r,
      m: Math.min(131072, g)
    };
  } else if ((n >> 4 | e[3] << 20) == 25481893)
    return Yr(e, 4) + 8;
  ct(0);
}, Vt = function(e) {
  for (var t = 0; 1 << t <= e; ++t)
    ;
  return t - 1;
}, Me = function(e, t, n) {
  var s = (t << 3) + 4, i = (e[t] & 15) + 5;
  i > n && ct(3);
  for (var r = 1 << i, o = r, a = -1, l = -1, c = -1, u = r, h = new Ur(512 + (r << 2)), v = new zr(h, 0, 256), g = new Fe(h, 0, 256), p = new Fe(h, 512, r), m = 512 + (r << 1), k = new at(h, m, r), E = new at(h, m + r); a < 255 && o > 0; ) {
    var x = Vt(o + 1), y = s >> 3, R = (1 << x + 1) - 1, T = (e[y] | e[y + 1] << 8 | e[y + 2] << 16) >> (s & 7) & R, f = (1 << x) - 1, w = R - o - 1, A = T & f;
    if (A < w ? (s += x, T = A) : (s += x + 1, T > f && (T -= w)), v[++a] = --T, T == -1 ? (o += T, k[--u] = a) : o -= T, !T)
      do {
        var $ = s >> 3;
        l = (e[$] | e[$ + 1] << 8) >> (s & 7) & 3, s += 2, a += l;
      } while (l == 3);
  }
  (a > 255 || o) && ct(0);
  for (var I = 0, F = (r >> 1) + (r >> 3) + 3, W = r - 1, O = 0; O <= a; ++O) {
    var N = v[O];
    if (N < 1) {
      g[O] = -N;
      continue;
    }
    for (c = 0; c < N; ++c) {
      k[I] = O;
      do
        I = I + F & W;
      while (I >= u);
    }
  }
  for (I && ct(0), c = 0; c < r; ++c) {
    var S = g[k[c]]++, P = E[c] = i - Vt(S);
    p[c] = (S << P) - r;
  }
  return [s + 7 >> 3, {
    b: i,
    s: k,
    n: E,
    t: p
  }];
}, Kr = function(e, t) {
  var n = 0, s = -1, i = new at(292), r = e[t], o = i.subarray(0, 256), a = i.subarray(256, 268), l = new Fe(i.buffer, 268);
  if (r < 128) {
    var c = Me(e, t + 1, 6), u = c[0], h = c[1];
    t += r;
    var v = u << 3, g = e[t];
    g || ct(0);
    for (var p = 0, m = 0, k = h.b, E = k, x = (++t << 3) - 8 + Vt(g); x -= k, !(x < v); ) {
      var y = x >> 3;
      if (p += (e[y] | e[y + 1] << 8) >> (x & 7) & (1 << k) - 1, o[++s] = h.s[p], x -= E, x < v)
        break;
      y = x >> 3, m += (e[y] | e[y + 1] << 8) >> (x & 7) & (1 << E) - 1, o[++s] = h.s[m], k = h.n[p], p = h.t[p], E = h.n[m], m = h.t[m];
    }
    ++s > 255 && ct(0);
  } else {
    for (s = r - 127; n < s; n += 2) {
      var R = e[++t];
      o[n] = R >> 4, o[n + 1] = R & 15;
    }
    ++t;
  }
  var T = 0;
  for (n = 0; n < s; ++n) {
    var f = o[n];
    f > 11 && ct(0), T += f && 1 << f - 1;
  }
  var w = Vt(T) + 1, A = 1 << w, $ = A - T;
  for ($ & $ - 1 && ct(0), o[s++] = Vt($) + 1, n = 0; n < s; ++n) {
    var f = o[n];
    ++a[o[n] = f && w + 1 - f];
  }
  var I = new at(A << 1), F = I.subarray(0, A), W = I.subarray(A);
  for (l[w] = 0, n = w; n > 0; --n) {
    var O = l[n];
    fe(W, n, O, l[n - 1] = O + a[n] * (1 << w - n));
  }
  for (l[0] != A && ct(0), n = 0; n < s; ++n) {
    var N = o[n];
    if (N) {
      var S = l[N];
      fe(F, n, S, l[N] = S + (1 << w - N));
    }
  }
  return [t, {
    n: W,
    b: w,
    s: F
  }];
}, jr = Me(/* @__PURE__ */ new at([
  81,
  16,
  99,
  140,
  49,
  198,
  24,
  99,
  12,
  33,
  196,
  24,
  99,
  102,
  102,
  134,
  70,
  146,
  4
]), 0, 6)[1], qr = Me(/* @__PURE__ */ new at([
  33,
  20,
  196,
  24,
  99,
  140,
  33,
  132,
  16,
  66,
  8,
  33,
  132,
  16,
  66,
  8,
  33,
  68,
  68,
  68,
  68,
  68,
  68,
  68,
  68,
  36,
  9
]), 0, 6)[1], Zr = Me(/* @__PURE__ */ new at([
  32,
  132,
  16,
  66,
  102,
  70,
  68,
  68,
  68,
  68,
  36,
  73,
  2
]), 0, 5)[1], Is = function(e, t) {
  for (var n = e.length, s = new Ue(n), i = 0; i < n; ++i)
    s[i] = t, t += 1 << e[i];
  return s;
}, en = /* @__PURE__ */ new at((/* @__PURE__ */ new Ue([
  0,
  0,
  0,
  0,
  16843009,
  50528770,
  134678020,
  202050057,
  269422093
])).buffer, 0, 36), Jr = /* @__PURE__ */ Is(en, 0), nn = /* @__PURE__ */ new at((/* @__PURE__ */ new Ue([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  16843009,
  50528770,
  117769220,
  185207048,
  252579084,
  16
])).buffer, 0, 53), Qr = /* @__PURE__ */ Is(nn, 3), ue = function(e, t, n) {
  var s = e.length, i = t.length, r = e[s - 1], o = (1 << n.b) - 1, a = -n.b;
  r || ct(0);
  for (var l = 0, c = n.b, u = (s << 3) - 8 + Vt(r) - c, h = -1; u > a && h < i; ) {
    var v = u >> 3, g = (e[v] | e[v + 1] << 8 | e[v + 2] << 16) >> (u & 7);
    l = (l << c | g) & o, t[++h] = n.s[l], u -= c = n.n[l];
  }
  (u != a || h + 1 != i) && ct(0);
}, to = function(e, t, n) {
  var s = 6, i = t.length, r = i + 3 >> 2, o = r << 1, a = r + o;
  ue(e.subarray(s, s += e[0] | e[1] << 8), t.subarray(0, r), n), ue(e.subarray(s, s += e[2] | e[3] << 8), t.subarray(r, o), n), ue(e.subarray(s, s += e[4] | e[5] << 8), t.subarray(o, a), n), ue(e.subarray(s), t.subarray(a), n);
}, eo = function(e, t, n) {
  var s, i = t.b, r = e[i], o = r >> 1 & 3;
  t.l = r & 1;
  var a = r >> 3 | e[i + 1] << 5 | e[i + 2] << 13, l = (i += 3) + a;
  if (o == 1)
    return i >= e.length ? void 0 : (t.b = i + 1, n ? (fe(n, e[i], t.y, t.y += a), n) : fe(new at(a), e[i]));
  if (!(l > e.length)) {
    if (o == 0)
      return t.b = l, n ? (n.set(e.subarray(i, l), t.y), t.y += a, n) : Ve(e, i, l);
    if (o == 2) {
      var c = e[i], u = c & 3, h = c >> 2 & 3, v = c >> 4, g = 0, p = 0;
      u < 2 ? h & 1 ? v |= e[++i] << 4 | (h & 2 && e[++i] << 12) : v = c >> 3 : (p = h, h < 2 ? (v |= (e[++i] & 63) << 4, g = e[i] >> 6 | e[++i] << 2) : h == 2 ? (v |= e[++i] << 4 | (e[++i] & 3) << 12, g = e[i] >> 2 | e[++i] << 6) : (v |= e[++i] << 4 | (e[++i] & 63) << 12, g = e[i] >> 6 | e[++i] << 2 | e[++i] << 10)), ++i;
      var m = n ? n.subarray(t.y, t.y + t.m) : new at(t.m), k = m.length - v;
      if (u == 0)
        m.set(e.subarray(i, i += v), k);
      else if (u == 1)
        fe(m, e[i++], k);
      else {
        var E = t.h;
        if (u == 2) {
          var x = Kr(e, i);
          g += i - (i = x[0]), t.h = E = x[1];
        } else E || ct(0);
        (p ? to : ue)(e.subarray(i, i += g), m.subarray(k), E);
      }
      var y = e[i++];
      if (y) {
        y == 255 ? y = (e[i++] | e[i++] << 8) + 32512 : y > 127 && (y = y - 128 << 8 | e[i++]);
        var R = e[i++];
        R & 3 && ct(0);
        for (var T = [qr, Zr, jr], f = 2; f > -1; --f) {
          var w = R >> (f << 1) + 2 & 3;
          if (w == 1) {
            var A = new at([0, 0, e[i++]]);
            T[f] = {
              s: A.subarray(2, 3),
              n: A.subarray(0, 1),
              t: new Fe(A.buffer, 0, 1),
              b: 0
            };
          } else w == 2 ? (s = Me(e, i, 9 - (f & 1)), i = s[0], T[f] = s[1]) : w == 3 && (t.t || ct(0), T[f] = t.t[f]);
        }
        var $ = t.t = T, I = $[0], F = $[1], W = $[2], O = e[l - 1];
        O || ct(0);
        var N = (l << 3) - 8 + Vt(O) - W.b, S = N >> 3, P = 0, it = (e[S] | e[S + 1] << 8) >> (N & 7) & (1 << W.b) - 1;
        S = (N -= F.b) >> 3;
        var rt = (e[S] | e[S + 1] << 8) >> (N & 7) & (1 << F.b) - 1;
        S = (N -= I.b) >> 3;
        var ft = (e[S] | e[S + 1] << 8) >> (N & 7) & (1 << I.b) - 1;
        for (++y; --y; ) {
          var mt = W.s[it], Bt = W.n[it], vt = I.s[ft], wt = I.n[ft], Tt = F.s[rt], U = F.n[rt];
          S = (N -= Tt) >> 3;
          var tt = 1 << Tt, q = tt + ((e[S] | e[S + 1] << 8 | e[S + 2] << 16 | e[S + 3] << 24) >>> (N & 7) & tt - 1);
          S = (N -= nn[vt]) >> 3;
          var dt = Qr[vt] + ((e[S] | e[S + 1] << 8 | e[S + 2] << 16) >> (N & 7) & (1 << nn[vt]) - 1);
          S = (N -= en[mt]) >> 3;
          var Mt = Jr[mt] + ((e[S] | e[S + 1] << 8 | e[S + 2] << 16) >> (N & 7) & (1 << en[mt]) - 1);
          if (S = (N -= Bt) >> 3, it = W.t[it] + ((e[S] | e[S + 1] << 8) >> (N & 7) & (1 << Bt) - 1), S = (N -= wt) >> 3, ft = I.t[ft] + ((e[S] | e[S + 1] << 8) >> (N & 7) & (1 << wt) - 1), S = (N -= U) >> 3, rt = F.t[rt] + ((e[S] | e[S + 1] << 8) >> (N & 7) & (1 << U) - 1), q > 3)
            t.o[2] = t.o[1], t.o[1] = t.o[0], t.o[0] = q -= 3;
          else {
            var d = q - (Mt != 0);
            d ? (q = d == 3 ? t.o[0] - 1 : t.o[d], d > 1 && (t.o[2] = t.o[1]), t.o[1] = t.o[0], t.o[0] = q) : q = t.o[0];
          }
          for (var f = 0; f < Mt; ++f)
            m[P + f] = m[k + f];
          P += Mt, k += Mt;
          var M = P - q;
          if (M < 0) {
            var L = -M, C = t.e + M;
            L > dt && (L = dt);
            for (var f = 0; f < L; ++f)
              m[P + f] = t.w[C + f];
            P += L, dt -= L, M = 0;
          }
          for (var f = 0; f < dt; ++f)
            m[P + f] = m[M + f];
          P += dt;
        }
        if (P != k)
          for (; k < m.length; )
            m[P++] = m[k++];
        else
          P = m.length;
        n ? t.y += P : m = Ve(m, 0, P);
      } else if (n) {
        if (t.y += v, k)
          for (var f = 0; f < v; ++f)
            m[f] = m[k + f];
      } else k && (m = Ve(m, k));
      return t.b = l, m;
    }
    ct(2);
  }
}, no = function(e, t) {
  if (e.length == 1)
    return e[0];
  for (var n = new at(t), s = 0, i = 0; s < e.length; ++s) {
    var r = e[s];
    n.set(r, i), i += r.length;
  }
  return n;
};
function so(e, t) {
  for (var n = [], s = +!t, i = 0, r = 0; e.length; ) {
    var o = Xr(e, s || t);
    if (typeof o == "object") {
      for (s ? (t = null, o.w.length == o.u && (n.push(t = o.w), r += o.u)) : (n.push(t), o.e = 0); !o.l; ) {
        var a = eo(e, o, t);
        a || ct(5), t ? o.e = o.y : (n.push(a), r += a.length, Gr(o.w, 0, a.length), o.w.set(a, o.w.length - a.length));
      }
      i = o.b + o.c * 4;
    } else
      i = o;
    e = e.subarray(i);
  }
  return no(n, r);
}
function re(e) {
  return e.byteLength ? new Uint8Array(so(e)) : e;
}
function Tn(e) {
  const t = [], n = [];
  if (e.byteLength === 0) return { events: t, density: n };
  const s = gn(e), i = s.numRows, r = (x) => s.getChild(x)?.toArray() ?? [], o = r("kind"), a = r("name"), l = r("cat"), c = r("ph"), u = r("pid"), h = r("tid"), v = r("ts"), g = r("dur"), p = r("depth"), m = r("args"), k = r("count"), E = r("total");
  for (let x = 0; x < i; x++)
    if (Number(o[x]) === 0) {
      let y;
      const R = m[x] ? String(m[x]) : "";
      if (R)
        try {
          y = JSON.parse(R);
        } catch {
          y = void 0;
        }
      t.push({
        name: String(a[x] ?? ""),
        cat: String(l[x] ?? ""),
        ph: String(c[x] ?? "X"),
        pid: Number(u[x] ?? 0),
        tid: Number(h[x] ?? 0),
        ts: Number(v[x] ?? 0),
        dur: Number(g[x] ?? 0),
        depth: Number(p[x] ?? 0),
        args: y
      });
    } else
      n.push({
        name: String(a[x] ?? ""),
        pid: Number(u[x] ?? 0),
        tid: Number(h[x] ?? 0),
        ts: Number(v[x] ?? 0),
        dur: Number(g[x] ?? 0),
        count: Number(k[x] ?? 0),
        total: Number(E[x] ?? 0),
        depth: Number(p[x] ?? 0)
      });
  return { events: t, density: n };
}
function io(e) {
  const t = [];
  if (e.byteLength === 0) return t;
  const n = gn(e), s = n.numRows, i = (p) => n.getChild(p)?.toArray() ?? [], r = i("pid"), o = i("parent"), a = i("spawn_ts"), l = i("first_ts"), c = i("host"), u = i("rank"), h = i("bytes"), v = i("io_ops"), g = i("io_busy");
  for (let p = 0; p < s; p++)
    t.push({
      pid: Number(r[p] ?? 0),
      parent: Number(o[p] ?? -1),
      spawn_ts: Number(a[p] ?? 0),
      first_ts: Number(l[p] ?? 0),
      host: c[p] ? String(c[p]) : "",
      rank: u[p] != null ? String(u[p]) : "",
      bytes: Number(h[p] ?? 0),
      io_ops: Number(v[p] ?? 0),
      io_busy: Number(g[p] ?? 0)
    });
  return t;
}
function ro(e) {
  if (e.byteLength === 0) return { read: [], write: [] };
  const t = gn(e);
  return {
    read: Array.from(t.getChild("read_bytes")?.toArray() ?? [], Number),
    write: Array.from(
      t.getChild("write_bytes")?.toArray() ?? [],
      Number
    )
  };
}
const Ln = [
  "#4bb0c4",
  // teal (read)
  "#e6a13c",
  // amber (write)
  "#5f7d52",
  // olive (compute)
  "#b06fc4",
  // orchid (meta)
  "#d1524e",
  // red (sync)
  "#5b8fd1",
  // blue (mpi)
  "#9aa84e",
  // olive-yellow (seek)
  "#c98a5a",
  // clay
  "#6fb3a0",
  // sage
  "#c76f96",
  // dusty rose
  "#8f9bd6",
  // periwinkle
  "#b3924e",
  // bronze
  "#7fb36a",
  // leaf
  "#d0a24e",
  // wheat
  "#9a7bc4",
  // muted violet
  "#6aa9bf"
  // steel
], Bn = /* @__PURE__ */ new Map();
let $n = 0;
function Rn(e) {
  let t = Bn.get(e);
  return t || (t = Ln[$n % Ln.length], $n += 1, Bn.set(e, t), t);
}
function oo(e) {
  const t = e.replace("#", ""), n = parseInt(t.slice(0, 2), 16), s = parseInt(t.slice(2, 4), 16), i = parseInt(t.slice(4, 6), 16);
  return (0.299 * n + 0.587 * s + 0.114 * i) / 255 > 0.6 ? "rgba(10,12,18,0.95)" : "rgba(255,255,255,0.95)";
}
function _n(e) {
  const t = e.name != null ? String(e.name) : "", n = e.cat != null ? String(e.cat) : "";
  return t || n;
}
function Zt(e) {
  const t = Math.abs(e);
  return t === 0 ? "0" : t < 1 ? `${(e * 1e3).toFixed(0)}ns` : t < 1e3 ? `${e.toFixed(t < 10 ? 2 : 0)}us` : t < 1e6 ? `${(e / 1e3).toFixed(t < 1e4 ? 2 : 1)}ms` : `${(e / 1e6).toFixed(t < 1e7 ? 3 : 2)}s`;
}
function ao(e, t) {
  const n = Math.abs(e);
  if (n === 0) return "0";
  let s, i;
  n >= 1e6 ? (s = 1e6, i = "s") : n >= 1e3 ? (s = 1e3, i = "ms") : (s = 1, i = "us");
  const r = t / s, o = r >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(r)));
  return `${(e / s).toFixed(o)}${i}`;
}
function lo(e) {
  const t = ["B", "K", "M", "G", "T", "P"];
  let n = 0;
  for (; e >= 1024 && n < t.length - 1; )
    e /= 1024, n++;
  return (n === 0 ? Math.round(e) : e.toFixed(e < 10 ? 1 : 0)) + t[n];
}
function co(e) {
  return e <= 0 ? "-" : e >= 1e6 ? `${(e / 1e6).toFixed(1)}M/s` : e >= 1e3 ? `${(e / 1e3).toFixed(1)}k/s` : `${Math.round(e)}/s`;
}
function In(e) {
  return e < 1024 ? `${e.toFixed(0)} B/s` : e < 1024 * 1024 ? `${(e / 1024).toFixed(1)} KB/s` : e < 1024 * 1024 * 1024 ? `${(e / 1024 / 1024).toFixed(1)} MB/s` : `${(e / 1024 / 1024 / 1024).toFixed(2)} GB/s`;
}
function ho(e) {
  if (e <= 0) return 1;
  const t = Math.pow(10, Math.floor(Math.log10(e))), n = e / t;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * t;
}
const En = 1, uo = 0.03;
function Cn(e, t, n) {
  const s = Math.max(t, En), i = [...e].sort((g, p) => g.begin - p.begin);
  if (!n || i.length === 0)
    return {
      enabled: !1,
      displayTotal: s,
      breakUs: 0,
      gaps: i,
      toDisplay: (g) => g,
      toReal: (g) => g
    };
  let r = 0;
  for (const g of i) r += Math.max(0, g.end - g.begin);
  const a = Math.max(En, s - r) * uo / i.length, l = [{ r: 0, d: 0 }];
  let c = 0, u = 0;
  for (const g of i) {
    const p = Math.max(u, g.begin), m = Math.max(p, g.end);
    c += p - u, l.push({ r: p, d: c }), c += a, l.push({ r: m, d: c }), u = m;
  }
  return c += s - u, l.push({ r: s, d: c }), { enabled: !0, displayTotal: c, breakUs: a, gaps: i, toDisplay: (g) => {
    if (g <= l[0].r) return l[0].d;
    for (let p = 1; p < l.length; p++)
      if (g <= l[p].r) {
        const m = l[p].r - l[p - 1].r, k = m > 0 ? (g - l[p - 1].r) / m : 0;
        return l[p - 1].d + k * (l[p].d - l[p - 1].d);
      }
    return l[l.length - 1].d;
  }, toReal: (g) => {
    if (g <= l[0].d) return l[0].r;
    for (let p = 1; p < l.length; p++)
      if (g <= l[p].d) {
        const m = l[p].d - l[p - 1].d, k = m > 0 ? (g - l[p - 1].d) / m : 0;
        return l[p - 1].r + k * (l[p].r - l[p - 1].r);
      }
    return l[l.length - 1].r;
  } };
}
const fo = {
  plotBg: "#0a0b0a",
  panelBg: "#0c0e0b",
  grid: "#16180f",
  divider: "#1f2119",
  laneAlt: "#0d0f0c",
  groupBand: "#12140f",
  groupText: "#e6e2ce",
  laneText: "#8a927c",
  numText: "#8a927c",
  ruler: "#7d876b",
  read: "#4bb0c4",
  write: "#e6a13c",
  counterLabel: "#d6d3c0",
  miniBg: "#0a0b0a",
  miniIdle: "rgba(255,255,255,0.03)",
  miniActivity: "120,164,150",
  accent: "#e6a13c",
  accentSoft: "rgba(230,161,60,0.16)",
  selFill: "rgba(230,161,60,0.14)",
  selStroke: "rgba(230,161,60,0.9)",
  gapFill: "rgba(209,82,78,0.16)",
  gapActiveFill: "rgba(209,82,78,0.34)",
  gapStroke: "rgba(209,82,78,0.95)",
  ttBg: "#12140f",
  ttBorder: "#3a3d30",
  ttName: "#e6e2ce",
  ttHot: "#e6a13c",
  crosshair: "rgba(230,161,60,0.35)",
  crosshairText: "#e6a13c",
  flameAncestor: "#2a2d24",
  flameAncestorText: "#c9c5b2",
  flameLabelDark: "#0a0b0a"
}, po = {
  plotBg: "#fffdf7",
  panelBg: "#f1ece2",
  grid: "#f0eadd",
  divider: "#e2dccd",
  laneAlt: "#faf7ef",
  groupBand: "#f3eee4",
  groupText: "#2a2620",
  laneText: "#6f6656",
  numText: "#8a8272",
  ruler: "#a89f8c",
  read: "#2c8296",
  write: "#bf7d1e",
  counterLabel: "#2a2620",
  miniBg: "#f3eee4",
  miniIdle: "rgba(0,0,0,0.04)",
  miniActivity: "120,90,40",
  accent: "#c2740f",
  accentSoft: "rgba(194,116,15,0.16)",
  selFill: "rgba(194,116,15,0.13)",
  selStroke: "rgba(194,116,15,0.85)",
  gapFill: "rgba(192,57,43,0.14)",
  gapActiveFill: "rgba(192,57,43,0.28)",
  gapStroke: "rgba(192,57,43,0.85)",
  ttBg: "#fffdf7",
  ttBorder: "#ddd6c8",
  ttName: "#2a2620",
  ttHot: "#bf7d1e",
  crosshair: "rgba(194,116,15,0.3)",
  crosshairText: "#bf7d1e",
  flameAncestor: "#e8e1d2",
  flameAncestorText: "#4a4438",
  flameLabelDark: "#2a2620"
};
function Dn(e) {
  return e === "light" ? po : fo;
}
const D = 348, oe = 128, Ye = 44, Fn = 282, Xe = D - 12, _ = 28, lt = 18, go = 6, mo = 12, xe = 14, ae = 1, ke = 16;
function Nn(e) {
  const t = e.startsWith("#") ? e.slice(1) : e, n = parseInt(t.length === 3 ? t.replace(/./g, "$&$&") : t, 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
const On = 0.22, vo = 130, yo = 25e-4, Pn = 90, kt = 600, bo = /* @__PURE__ */ new Set(["w", "a", "s", "d", "arrowleft", "arrowright", "arrowup", "arrowdown"]);
function j(e, t, n) {
  return e < t ? t : e > n ? n : e;
}
function Wn(e, t = 0) {
  const n = typeof e == "number" ? e : Number(e);
  return Number.isFinite(n) ? n : t;
}
class wo {
  constructor(t, n) {
    this.dpr = 1, this.cssW = 0, this.cssH = 0, this.totalSpan = 1, this.live = { begin: 0, end: 1 }, this.target = { begin: 0, end: 1 }, this.slices = [], this.slicesByKey = /* @__PURE__ */ new Map(), this.lanes = [], this.colorMode = "category", this.durDomain = [0, 1], this.sizeDomain = [0, 1], this.contentH = 0, this.scrollY = 0, this.processLabels = /* @__PURE__ */ new Map(), this.laneRegistry = /* @__PURE__ */ new Set(), this.procOrder = /* @__PURE__ */ new Map(), this.procDepth = /* @__PURE__ */ new Map(), this.procParent = /* @__PURE__ */ new Map(), this.procSpawn = /* @__PURE__ */ new Map(), this.procFirst = /* @__PURE__ */ new Map(), this.hasRanks = !1, this.miniW = 0, this.miniH = 0, this.miniActivity = [], this.miniActivityMax = 1, this.overviewLanes = /* @__PURE__ */ new Map(), this.overviewMax = 1, this.ovOpsByPid = /* @__PURE__ */ new Map(), this.ioBusyByPid = /* @__PURE__ */ new Map(), this.miniDragging = !1, this.miniAnchorT = 0, this.miniAnchorX = 0, this.miniMoved = !1, this.miniSel = null, this.searchTerm = "", this.searchMatches = [], this.searchMatchSet = /* @__PURE__ */ new Set(), this.searchIdx = -1, this.counterW = 0, this.counterH = 0, this.counterPeak = 1, this.laneCounter = null, this.gaps = [], this.showGaps = !1, this.hoveredGap = null, this.selectedGap = null, this.runGaps = [], this.timelapse = !1, this.realTotal = 1, this.axis = Cn([], 1, !1), this.selected = null, this.hovered = null, this.dragging = !1, this.lastX = 0, this.lastY = 0, this.moved = !1, this.gutterDown = null, this.mouseX = D, this.cursorInside = !1, this.keys = /* @__PURE__ */ new Set(), this.pendingZoom = 0, this.zoomFocusX = D, this.selecting = !1, this.selAnchorT = 0, this.selection = null, this.th = Dn("dark"), this.hostByPid = /* @__PURE__ */ new Map(), this.hostPids = /* @__PURE__ */ new Map(), this.bytesByPid = /* @__PURE__ */ new Map(), this.collapsed = /* @__PURE__ */ new Set(), this.raf = 0, this.frameScheduled = !1, this._dirty = !0, this.rangeTimer = 0, this.onWheel = (i) => {
      i.preventDefault();
      const { x: r } = this.localPos(i);
      if (i.ctrlKey || i.metaKey) {
        const l = i.deltaMode === 1 ? i.deltaY * 16 : i.deltaMode === 2 ? i.deltaY * this.cssH : i.deltaY;
        this.pendingZoom += l, this.zoomFocusX = r, this.requestFrame();
        return;
      }
      const o = this.target.end - this.target.begin, a = i.shiftKey ? i.deltaY : i.deltaX;
      a !== 0 && this.panBy(a / this.plotW() * o), !i.shiftKey && i.deltaY !== 0 && (this.scrollY += i.deltaY, this.clampScroll(), this.invalidate());
    }, this.onKeyDown = (i) => {
      const r = document.activeElement;
      if (r && (r.tagName === "INPUT" || r.tagName === "TEXTAREA")) return;
      const o = i.key.toLowerCase();
      bo.has(o) && (this.keys.add(o), i.preventDefault(), this.requestFrame());
    }, this.onKeyUp = (i) => {
      this.keys.delete(i.key.toLowerCase());
    }, this.onMouseDown = (i) => {
      const { x: r, y: o } = this.localPos(i);
      if (r >= D && (o < _ || i.shiftKey)) {
        this.selecting = !0, this.selAnchorT = this.timeOf(r), this.selection = { t0: this.selAnchorT, t1: this.selAnchorT }, this.invalidate();
        return;
      }
      if (r < D && o > _) {
        this.gutterDown = { x: r, y: o };
        return;
      }
      this.dragging = !0, this.moved = !1, this.lastX = r, this.lastY = o;
    }, this.onMouseMove = (i) => {
      const { x: r, y: o } = this.localPos(i);
      if (this.mouseX = r, this.selecting) {
        const c = j(this.timeOf(r), 0, this.totalSpan);
        this.selection = {
          t0: Math.min(this.selAnchorT, c),
          t1: Math.max(this.selAnchorT, c)
        }, this.invalidate();
        return;
      }
      if (this.dragging) {
        const c = r - this.lastX, u = o - this.lastY;
        Math.abs(c) + Math.abs(u) > 2 && (this.moved = !0);
        const h = this.target.end - this.target.begin, v = -(c / this.plotW()) * h, g = j(this.target.begin + v, 0, this.totalSpan - h);
        this.target = { begin: g, end: g + h }, this.scrollY -= u, this.clampScroll(), this.lastX = r, this.lastY = o, this.invalidate(), this.emitRange(!1);
        return;
      }
      if (r < 0 || r > this.cssW || o < 0 || o > this.cssH) {
        (this.hovered || this.hoveredGap) && (this.hovered = null, this.hoveredGap = null, this.invalidate()), this.cursorInside = !1, this.cb.onHover?.(null, 0, 0);
        return;
      }
      this.cursorInside = r >= D && o >= _ && r <= this.cssW, this.cursorInside ? this.canvas.style.cursor = "crosshair" : r < D && o > _ && this.gutterRowAt(o) ? this.canvas.style.cursor = "pointer" : this.canvas.style.cursor = "default";
      const a = this.hitTest(r, o), l = a ? null : this.gapAt(r, o);
      (a !== this.hovered || l !== this.hoveredGap || this.cursorInside) && (this.hovered = a, this.hoveredGap = l, this.invalidate()), this.cb.onHover?.(a?.ev ?? null, i.clientX, i.clientY), this.cb.onHeaderHover?.(this.headerKeyAt(r, o), i.clientX, i.clientY);
    }, this.onMouseUp = (i) => {
      if (this.gutterDown) {
        const r = this.gutterDown;
        this.gutterDown = null;
        const { x: o, y: a } = this.localPos(i);
        if (Math.abs(o - r.x) + Math.abs(a - r.y) < 4) {
          const l = this.gutterRowAt(a);
          l?.collapsible && this.toggleCollapse(l.collapseKey);
        }
        return;
      }
      if (this.selecting) {
        this.selecting = !1;
        const r = this.selection, o = this.live.end - this.live.begin;
        r && r.t1 - r.t0 > o * 2e-3 ? this.cb.onSelectRange?.(this.toReal(r.t0), this.toReal(r.t1)) : (this.selection = null, this.cb.onSelectRangeClear?.()), this.invalidate();
        return;
      }
      if (this.dragging && !this.moved) {
        const { x: r, y: o } = this.localPos(i), a = this.hitTest(r, o);
        !a && r > D && this.selection && (this.selection = null, this.cb.onSelectRangeClear?.()), this.selectedGap = a ? null : this.gapAt(r, o), this.selected = a?.ev ?? null, this.cb.onSelect?.(this.selected), this.invalidate();
      }
      this.dragging = !1;
    }, this.onMouseLeave = () => {
      this.cursorInside = !1, this.hovered && (this.hovered = null), this.invalidate(), this.cb.onHover?.(null, 0, 0), this.cb.onHeaderHover?.(null, 0, 0);
    }, this.onDblClick = (i) => {
      const { x: r } = this.localPos(i), o = this.timeOf(r), a = this.target.end - this.target.begin, l = j(a * 0.4, ae, this.totalSpan), c = j(o - l / 2, 0, this.totalSpan - l);
      this.target = { begin: c, end: c + l }, this.invalidate(), this.emitRange(!1);
    }, this.onMiniDown = (i) => {
      this.mini && (i.preventDefault(), this.miniDragging = !0, this.miniMoved = !1, this.miniAnchorT = this.miniTimeAt(i), this.miniAnchorX = i.clientX, this.miniSel = null);
    }, this.onMiniMove = (i) => {
      if (this.miniDragging && (Math.abs(i.clientX - this.miniAnchorX) > 3 && (this.miniMoved = !0), this.miniMoved)) {
        const r = this.miniTimeAt(i);
        this.miniSel = {
          t0: Math.min(this.miniAnchorT, r),
          t1: Math.max(this.miniAnchorT, r)
        }, this.invalidate();
      }
    }, this.onMiniUp = () => {
      if (this.miniDragging && this.miniMoved && this.miniSel) {
        const { t0: i, t1: r } = this.miniSel, o = j(i, 0, this.totalSpan), a = j(Math.max(r, o + ae), 0, this.totalSpan);
        this.target = { begin: o, end: a }, this.invalidate(), this.emitRange(!1);
      } else this.miniDragging && !this.miniMoved && this.centerViewportAt(this.miniAnchorT);
      this.miniDragging = !1, this.miniSel = null, this.invalidate();
    }, this.frame = () => {
      if (this.frameScheduled = !1, this.applyKeys(), this.pendingZoom !== 0) {
        const l = j(this.pendingZoom, -Pn, Pn);
        this.zoomAt(this.zoomFocusX, l), this.pendingZoom -= l, Math.abs(this.pendingZoom) < 1 && (this.pendingZoom = 0);
      }
      const i = this.live.end - this.live.begin, r = this.target.begin - this.live.begin, o = this.target.end - this.live.end;
      let a = !1;
      Math.abs(r) > i * 1e-4 || Math.abs(o) > i * 1e-4 ? (this.live.begin += r * On, this.live.end += o * On, this._dirty = !0, a = !0) : (this.live.begin !== this.target.begin || this.live.end !== this.target.end) && (this.live.begin = this.target.begin, this.live.end = this.target.end, this._dirty = !0), this._dirty && (this.render(), this.renderMinimap(), this.renderCounters(), this.cb.onFrame?.(), this._dirty = !1), (a || this.keys.size > 0 || this.pendingZoom !== 0) && this.requestFrame();
    }, this.canvas = t, this.cb = n;
    const s = t.getContext("2d");
    if (!s) throw new Error("2D canvas context unavailable");
    this.ctx = s, t.addEventListener("wheel", this.onWheel, { passive: !1 }), t.addEventListener("mousedown", this.onMouseDown), window.addEventListener("mousemove", this.onMouseMove), window.addEventListener("mouseup", this.onMouseUp), t.addEventListener("mouseleave", this.onMouseLeave), t.addEventListener("dblclick", this.onDblClick), window.addEventListener("keydown", this.onKeyDown), window.addEventListener("keyup", this.onKeyUp), this.ro = new ResizeObserver(() => {
      this.resize();
    }), this.ro.observe(t.parentElement ?? t), this.resize(), this.requestFrame();
  }
  destroy() {
    cancelAnimationFrame(this.raf), this.rangeTimer && clearTimeout(this.rangeTimer), this.ro?.disconnect(), this.canvas.removeEventListener("wheel", this.onWheel), this.canvas.removeEventListener("mousedown", this.onMouseDown), window.removeEventListener("mousemove", this.onMouseMove), window.removeEventListener("mouseup", this.onMouseUp), this.canvas.removeEventListener("mouseleave", this.onMouseLeave), this.canvas.removeEventListener("dblclick", this.onDblClick), window.removeEventListener("keydown", this.onKeyDown), window.removeEventListener("keyup", this.onKeyUp), this.mini?.removeEventListener("mousedown", this.onMiniDown), window.removeEventListener("mousemove", this.onMiniMove), window.removeEventListener("mouseup", this.onMiniUp);
  }
  setTheme(t) {
    this.th = Dn(t), this.invalidate();
  }
  setTotalSpan(t) {
    this.realTotal = Math.max(t, ae), this.rebuildAxis(), this.totalSpan = Math.max(this.toDisplay(this.realTotal), ae), this.target = { begin: 0, end: this.totalSpan }, this.live = { begin: 0, end: this.totalSpan }, this.invalidate(), this.emitRange(!0);
  }
  // Between-run idle spans (real us) plus whether to auto-enable compression.
  setBreaks(t, n) {
    this.runGaps = [...t].sort((s, i) => s.begin - i.begin), this.timelapse = n && this.runGaps.length > 0, this.setTotalSpan(this.realTotal);
  }
  hasBreaks() {
    return this.runGaps.length > 0;
  }
  isTimelapse() {
    return this.timelapse;
  }
  setTimelapse(t) {
    this.timelapse = t && this.runGaps.length > 0, this.setTotalSpan(this.realTotal), this.resetView();
  }
  rebuildAxis() {
    this.axis = Cn(this.runGaps, this.realTotal, this.timelapse);
  }
  toDisplay(t) {
    return this.axis.toDisplay(t);
  }
  toReal(t) {
    return this.axis.toReal(t);
  }
  // Display us -> screen x (viewport-space, no gap remap).
  xdOf(t) {
    const n = this.live.end - this.live.begin;
    return D + (t - this.live.begin) / n * this.plotW();
  }
  resetView() {
    this.target = { begin: 0, end: this.totalSpan }, this.scrollY = 0, this.invalidate(), this.emitRange(!1);
  }
  getViewport() {
    return { begin: this.toReal(this.target.begin), end: this.toReal(this.target.end) };
  }
  // Live plot fraction [0,1] of a real timestamp (timelapse-aware, eased).
  // Used by overlays to place series in sync with the track slices per frame.
  frac(t) {
    return (this.xOf(t) - D) / this.plotW();
  }
  // Inverse of frac against the live viewport: real timestamp at a plot fraction.
  realAtFrac(t) {
    return this.toReal(this.live.begin + t * (this.live.end - this.live.begin));
  }
  setSelected(t) {
    this.selected = t, this.invalidate();
  }
  // Human-readable label per process id (e.g. resolved host name).
  setProcessLabels(t) {
    this.processLabels = t, this.layoutLanes();
  }
  // Fork hierarchy: order processes by DFS (children after parent) and record
  // depth + spawn time so lanes indent and spawn arrows can be drawn.
  setProcTree(t) {
    this.procOrder = /* @__PURE__ */ new Map(), this.procDepth = /* @__PURE__ */ new Map(), this.procParent = /* @__PURE__ */ new Map(), this.procSpawn = /* @__PURE__ */ new Map(), this.procFirst = /* @__PURE__ */ new Map();
    const n = /* @__PURE__ */ new Map(), s = /* @__PURE__ */ new Set();
    for (const h of t)
      if (s.add(h.pid), this.procParent.set(h.pid, h.parent), this.procSpawn.set(h.pid, h.spawn_ts), this.procFirst.set(h.pid, h.first_ts), h.parent >= 0) {
        const v = n.get(h.parent);
        v ? v.push(h.pid) : n.set(h.parent, [h.pid]);
      }
    const i = new Map(t.map((h) => [h.pid, h.first_ts])), r = (h, v) => (i.get(h) ?? 0) - (i.get(v) ?? 0), o = /* @__PURE__ */ new Map();
    for (const h of t) {
      const v = h.rank != null && h.rank !== "" ? Number(h.rank) : NaN;
      Number.isFinite(v) && o.set(h.pid, v);
    }
    this.hasRanks = o.size > 0;
    const a = (h, v) => (o.get(h) ?? 1 / 0) - (o.get(v) ?? 1 / 0) || r(h, v), l = t.filter((h) => h.parent < 0 || !s.has(h.parent)).map((h) => h.pid).sort(this.hasRanks ? a : r);
    let c = 0;
    const u = (h, v) => {
      this.procOrder.set(h, c++), this.procDepth.set(h, v);
      for (const g of (n.get(h) ?? []).slice().sort(r))
        u(g, v + 1);
    };
    for (const h of l) u(h, 0);
    this.relayoutLanes();
  }
  // Re-sort existing lanes into fork-hierarchy DFS order and re-flow their y
  // offsets, remapping slices to their new lane index. Used when the process
  // tree arrives after lanes were first built in plain pid order.
  relayoutLanes() {
    this.layoutLanes();
  }
  // --- Gap / idle analysis --------------------------------------------------
  setShowGaps(t) {
    this.showGaps = t, t || (this.hoveredGap = null, this.selectedGap = null), this.invalidate();
  }
  // Idle periods per lane: the complement of its busy coverage. A density block
  // tiles the full bucket width but is only busy for `total`, so it counts as
  // busy only when total/dur clears IDLE_FRAC; real slices are always busy.
  computeGaps() {
    const n = /* @__PURE__ */ new Map();
    for (const i of this.slices) {
      let r = n.get(i.laneIdx);
      r || (r = [], n.set(i.laneIdx, r)), r.push(i);
    }
    const s = [];
    for (const [i, r] of n) {
      const o = this.lanes[i], a = this.processLabels.get(o.pid) ?? o.key, l = [];
      for (const v of r) {
        if (v.ev.cat === "dftracer") continue;
        const g = Math.max(v.dur, 0);
        v.density && (g <= 0 || Math.min(v.total, g) / g < 0.02) || l.push([v.ts, v.ts + g]);
      }
      l.sort((v, g) => v[0] - g[0]);
      const c = this.totalSpan * 1e-6;
      let u = -1 / 0, h = !1;
      for (const [v, g] of l) {
        if (!h) {
          u = g, h = !0;
          continue;
        }
        v > u + c ? (s.push({ laneIdx: i, label: a, t0: u, t1: v, dur: v - u }), u = g) : g > u && (u = g);
      }
    }
    s.sort((i, r) => r.dur - i.dur), this.gaps = s;
  }
  topGaps(t) {
    return this.gaps.slice(0, t).map((n) => {
      const s = this.lanes[n.laneIdx];
      return { ...n, label: this.processLabels.get(s.pid) ?? s.key };
    });
  }
  // Fit the viewport to [t0, t1] with a little padding.
  // Zoom to a real-time range (timelapse-aware). focusRange works in display
  // coords; real coords diverge from those once timelapse compresses gaps.
  focusRealRange(t, n) {
    this.focusRange(this.toDisplay(t), this.toDisplay(n));
  }
  focusRange(t, n) {
    const s = Math.max((n - t) * 0.3, 1), i = j(t - s, 0, this.totalSpan), r = j(n + s, 0, this.totalSpan);
    r > i && (this.target = { begin: i, end: r }, this.invalidate(), this.emitRange(!1));
  }
  renderGaps(t) {
    if (!this.showGaps) return;
    t.save(), t.beginPath(), t.rect(D, _, this.cssW - D, this.cssH - _), t.clip();
    const n = this.selectedGap ?? this.hoveredGap;
    for (const s of this.gaps) {
      const i = this.xOf(s.t0), r = this.xOf(s.t1);
      if (r - i < 3 || r < D || i > this.cssW) continue;
      const o = this.lanes[s.laneIdx], a = _ - this.scrollY + o.y, l = o.rows * lt;
      if (a + l < _ || a > this.cssH) continue;
      const c = Math.max(i, D), u = Math.min(r, this.cssW) - c, h = Math.max(a, _), v = s === n;
      t.fillStyle = v ? this.th.gapActiveFill : this.th.gapFill, t.fillRect(c, h, u, l - (a < _ ? _ - a : 0)), v && (t.strokeStyle = this.th.gapStroke, t.lineWidth = 1, t.strokeRect(c + 0.5, h + 0.5, u - 1, l - 1 - (a < _ ? _ - a : 0)));
    }
    t.restore(), n && this.renderGapReadout(t, n);
  }
  renderGapReadout(t, n) {
    const s = this.xOf(n.t0), i = this.xOf(n.t1), r = this.lanes[n.laneIdx], o = _ - this.scrollY + r.y, a = `idle ${Zt(n.dur)}`;
    t.save(), t.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    const l = t.measureText(a).width, c = 6, u = l + c * 2, h = 18, v = j((s + i) / 2 - u / 2, D + 2, this.cssW - u - 2), g = j(o - h - 4, _ + 2, this.cssH - h - 2);
    t.fillStyle = this.th.ttBg, t.strokeStyle = this.th.gapStroke, t.lineWidth = 1, t.beginPath(), t.rect(v, g, u, h), t.fill(), t.stroke(), t.fillStyle = this.th.gapStroke, t.textBaseline = "middle", t.fillText(a, v + c, g + h / 2 + 0.5), t.restore();
  }
  // --- Search: highlight slices whose name matches; dim the rest -------------
  setSearch(t) {
    return this.searchTerm = t.trim().toLowerCase(), this.searchIdx = -1, this.recomputeMatches(), this.invalidate(), this.searchMatches.length;
  }
  recomputeMatches() {
    if (this.searchMatches = [], this.searchMatchSet = /* @__PURE__ */ new Set(), !!this.searchTerm) {
      for (const t of this.slices)
        _n(t.ev).toLowerCase().includes(this.searchTerm) && (this.searchMatches.push(t), this.searchMatchSet.add(t));
      this.searchMatches.sort((t, n) => t.ts - n.ts);
    }
  }
  // Move to the next/prev match, centering the viewport and selecting it.
  // Returns the 1-based match position (0 if none).
  focusMatch(t) {
    const n = this.searchMatches.length;
    if (n === 0) return 0;
    this.searchIdx = (this.searchIdx + t + n) % n;
    const s = this.searchMatches[this.searchIdx], i = this.toDisplay(s.ts + s.dur / 2), r = this.target.end - this.target.begin, o = j(i - r / 2, 0, Math.max(0, this.totalSpan - r));
    return this.target = { begin: o, end: o + r }, this.selected = s.ev, this.cb.onSelect?.(s.ev), this.invalidate(), this.emitRange(!1), this.searchIdx + 1;
  }
  setData(t, n = []) {
    const s = /* @__PURE__ */ new Map(), i = (r, o) => {
      let a = s.get(r);
      a || (a = [], s.set(r, a)), a.push(o);
    };
    for (const r of t) {
      if (r.ph === "M") continue;
      const o = Wn(r.ts), a = Wn(r.dur);
      !Number.isFinite(o) || a < 0 || i(`${r.pid}/${r.tid}`, {
        ev: r,
        ts: o,
        dur: a,
        laneIdx: 0,
        depth: 0,
        sdepth: typeof r.depth == "number" ? r.depth : -1,
        count: 1,
        total: a,
        density: !1
      });
    }
    for (const r of n) {
      const o = {
        name: r.name,
        cat: "",
        pid: r.pid,
        tid: r.tid,
        ts: r.ts,
        dur: r.dur,
        ph: "X",
        args: {},
        count: r.count,
        total: r.total,
        aggregated: !0
      };
      i(`${r.pid}/${r.tid}`, {
        ev: o,
        ts: r.ts,
        dur: r.dur,
        laneIdx: 0,
        depth: 0,
        sdepth: typeof r.depth == "number" ? r.depth : -1,
        count: r.count,
        total: r.total,
        density: !0
      });
    }
    for (const r of s.keys()) this.laneRegistry.add(r);
    this.slicesByKey = s, this.layoutLanes();
  }
  // Merge, never replace: the per-window HH scan is empty at full view and
  // would otherwise wipe the proctree-provided host map.
  setHosts(t) {
    let n = !1;
    for (const [s, i] of t)
      this.hostByPid.get(s) !== i && (this.hostByPid.set(s, i), n = !0);
    n && this.layoutLanes();
  }
  setBytes(t) {
    this.bytesByPid = t, this.invalidate();
  }
  toggleCollapse(t) {
    this.collapsed.has(t) ? this.collapsed.delete(t) : this.collapsed.add(t), this.layoutLanes();
  }
  // Build the gutter tree: host -> process (fork DFS) -> thread. Collapsed
  // groups fold their descendants' slices into one summary row so load still
  // shows. Assigns each slice a target lane + stack depth and flows y.
  layoutLanes() {
    const t = (y) => this.procOrder.get(y) ?? 1e9 + y, n = (y) => this.hostByPid.get(y) ?? "unknown", s = (y) => this.procParent.get(y), i = /* @__PURE__ */ new Set(), r = /* @__PURE__ */ new Map();
    for (const y of this.laneRegistry) {
      const R = y.indexOf("/"), T = Number(y.slice(0, R));
      i.add(T);
      let f = r.get(T);
      f || (f = [], r.set(T, f)), f.push(y.slice(R + 1));
    }
    for (const y of r.values()) y.sort((R, T) => Number(R) - Number(T));
    const o = (y, R) => i.has(y) && n(y) === R, a = /* @__PURE__ */ new Map();
    for (const y of i) {
      const R = s(y);
      if (R != null && R >= 0 && o(R, n(y))) {
        let T = a.get(R);
        T || (T = [], a.set(R, T)), T.push(y);
      }
    }
    for (const y of a.values()) y.sort((R, T) => t(R) - t(T));
    const l = /* @__PURE__ */ new Map();
    for (const y of i) {
      const R = n(y);
      let T = l.get(R);
      T || (T = [], l.set(R, T)), T.push(y);
    }
    const c = [...l.keys()].sort((y, R) => {
      const T = Math.min(...l.get(y).map(t)), f = Math.min(...l.get(R).map(t));
      return T - f || (y < R ? -1 : 1);
    });
    this.hostPids = l;
    const u = [], h = /* @__PURE__ */ new Map(), v = (y) => this.collapsed.has("host:" + y), g = (y) => this.collapsed.has("pid:" + y), p = (y, R) => {
      for (const T of r.get(y) ?? []) h.set(y + "/" + T, R);
      for (const T of a.get(y) ?? []) p(T, R);
    };
    for (const y of c) {
      const R = u.length, T = c.length === 1 && y === "unknown";
      if (!T && (u.push({
        key: "host:" + y,
        pid: "",
        tid: "",
        rows: 1,
        y: 0,
        kind: "host",
        label: y,
        indent: 0,
        collapsible: !0,
        collapseKey: "host:" + y,
        flatten: !0,
        host: y,
        processFirst: !0,
        soleThread: !1,
        depth: 0
      }), v(y))) {
        for (const $ of l.get(y)) p($, R);
        continue;
      }
      const f = T ? 0 : 1, w = l.get(y).filter(($) => {
        const I = s($);
        return !(I != null && I >= 0 && o(I, y));
      }).sort(($, I) => t($) - t(I)), A = ($, I) => {
        const F = r.get($) ?? [], W = F.length === 1, O = a.get($) ?? [], N = g($), S = u.length;
        if (u.push({
          key: "pid:" + $,
          pid: String($),
          tid: W ? F[0] : "",
          rows: 1,
          y: 0,
          kind: "proc",
          label: this.processLabels.get(String($)) ?? "proc " + $,
          indent: (f + I) * xe,
          collapsible: !0,
          collapseKey: "pid:" + $,
          flatten: N,
          host: y,
          processFirst: !0,
          soleThread: W,
          depth: I
        }), N) {
          p($, S);
          return;
        }
        if (W)
          h.set($ + "/" + F[0], S);
        else
          for (const P of F)
            h.set($ + "/" + P, u.length), u.push({
              key: $ + "/" + P,
              pid: String($),
              tid: P,
              rows: 1,
              y: 0,
              kind: "thread",
              label: "thread " + P,
              indent: (f + I + 1) * xe,
              collapsible: !1,
              collapseKey: "",
              flatten: !1,
              host: y,
              processFirst: !1,
              soleThread: !1,
              depth: I
            });
        for (const P of O) A(P, I + 1);
      };
      for (const $ of w) A($, 0);
    }
    const m = [], k = /* @__PURE__ */ new Map();
    for (const [y, R] of this.slicesByKey) {
      const T = h.get(y);
      if (T == null) continue;
      const f = u[T];
      R.sort((A, $) => A.ts - $.ts || $.dur - A.dur);
      let w = k.get(T);
      w || (w = [], k.set(T, w));
      for (const A of R) {
        for (; w.length && w[w.length - 1] <= A.ts; ) w.pop();
        A.laneIdx = T, f.flatten ? A.depth = 0 : A.sdepth >= 0 ? A.depth = A.sdepth : A.depth = w.length, !A.density && !f.flatten && A.sdepth < 0 && w.push(A.ts + Math.max(A.dur, 0)), f.rows = Math.max(f.rows, A.depth + 1), m.push(A);
      }
    }
    let E = 0, x = "";
    for (const y of u)
      y.kind === "host" && x && (E += mo), y.y = E, E += y.rows * lt + go, x = y.kind;
    this.slices = m, this.lanes = u, this.contentH = E, this.computeMetricDomains(), this.computeMiniActivity(), this.recomputeMatches(), this.computeGaps(), this.clampScroll(), this.invalidate();
  }
  setColorMode(t) {
    this.colorMode = t, this.invalidate();
  }
  get colorMetric() {
    return this.colorMode;
  }
  retOf(t) {
    const n = t.ev.args?.ret, s = typeof n == "number" ? n : typeof n == "string" ? Number(n) : NaN;
    return Number.isFinite(s) ? s : null;
  }
  computeMetricDomains() {
    let t = 1 / 0, n = 1, s = 1 / 0, i = 1;
    for (const r of this.slices) {
      const o = r.density ? r.count ? r.total / r.count : 0 : r.dur;
      if (o > 0 && (t = Math.min(t, o), n = Math.max(n, o)), !r.density) {
        const a = this.retOf(r);
        a != null && a > 0 && (s = Math.min(s, a), i = Math.max(i, a));
      }
    }
    this.durDomain = [Math.log(Number.isFinite(t) ? t : 1), Math.log(n)], this.sizeDomain = [Math.log(Number.isFinite(s) ? s : 1), Math.log(i)];
  }
  // Sequential ramp: dark base -> bright hue as the (log-normalized) metric rises.
  ramp(t, n) {
    const s = n === "lat" ? [26, 42, 48] : [48, 38, 20], i = n === "lat" ? [92, 200, 224] : [244, 176, 66], r = Math.max(0, Math.min(1, t));
    return `rgb(${Math.round(s[0] + (i[0] - s[0]) * r)},${Math.round(
      s[1] + (i[1] - s[1]) * r
    )},${Math.round(s[2] + (i[2] - s[2]) * r)})`;
  }
  metricFill(t) {
    if (this.colorMode === "category") return null;
    const n = "#3a3f36", s = (r, o) => o[1] > o[0] ? (r - o[0]) / (o[1] - o[0]) : 0.5;
    if (this.colorMode === "latency") {
      const r = t.density ? t.count ? t.total / t.count : 0 : t.dur;
      return r > 0 ? this.ramp(s(Math.log(r), this.durDomain), "lat") : n;
    }
    if (t.density) return n;
    const i = this.retOf(t);
    return i != null && i > 0 ? this.ramp(s(Math.log(i), this.sizeDomain), "size") : n;
  }
  // --- coordinate transforms -------------------------------------------------
  plotW() {
    return Math.max(1, this.cssW - D);
  }
  xOf(t) {
    return this.xdOf(this.toDisplay(t));
  }
  timeOf(t) {
    const n = this.live.end - this.live.begin;
    return this.live.begin + (t - D) / this.plotW() * n;
  }
  // --- interaction -----------------------------------------------------------
  localPos(t) {
    const n = this.canvas.getBoundingClientRect();
    return { x: t.clientX - n.left, y: t.clientY - n.top };
  }
  zoomAt(t, n) {
    const s = this.timeOf(t), i = this.target.end - this.target.begin, r = Math.exp(n * yo), o = j(i * r, ae, this.totalSpan), a = j((s - this.target.begin) / i, 0, 1);
    let l = s - a * o, c = l + o;
    l < 0 && (l = 0, c = o), c > this.totalSpan && (c = this.totalSpan, l = c - o), this.target = { begin: l, end: c }, this.invalidate(), this.emitRange(!1);
  }
  panBy(t) {
    const n = this.target.end - this.target.begin, s = j(this.target.begin + t, 0, Math.max(0, this.totalSpan - n));
    this.target = { begin: s, end: s + n }, this.invalidate(), this.emitRange(!1);
  }
  // Continuous WASD/arrow navigation, applied once per animation frame so held
  // keys pan/zoom smoothly (Perfetto-style: A/D pan, W/S zoom at the cursor).
  applyKeys() {
    if (this.keys.size === 0) return;
    const t = this.target.end - this.target.begin;
    (this.keys.has("a") || this.keys.has("arrowleft")) && this.panBy(-t * 0.02), (this.keys.has("d") || this.keys.has("arrowright")) && this.panBy(t * 0.02), (this.keys.has("w") || this.keys.has("arrowup")) && this.zoomAt(this.mouseX, -10), (this.keys.has("s") || this.keys.has("arrowdown")) && this.zoomAt(this.mouseX, 10);
  }
  // Gutter column-header key under the cursor (for metric help tooltips).
  headerKeyAt(t, n) {
    return n > _ || t > D ? null : t < 120 ? "track" : t < 228 ? "i/o util" : t < 288 ? "ops" : "bytes";
  }
  hasSelection() {
    return this.selection !== null;
  }
  clearSelection() {
    this.selection = null, this.invalidate();
  }
  hitTest(t, n) {
    if (t < D || n < _) return null;
    let s = null;
    for (const i of this.slices) {
      const r = this.xOf(i.ts), o = Math.max(this.xOf(i.ts + i.dur) - r, 1);
      if (t < r || t > r + o) continue;
      const a = this.lanes[i.laneIdx], l = _ - this.scrollY + a.y + i.depth * lt;
      n < l || n > l + lt || (!s || i.depth >= s.depth) && (s = i);
    }
    return s;
  }
  // Topmost visible gap under the cursor (only when gaps are shown).
  gapAt(t, n) {
    if (!this.showGaps || t < D || n < _) return null;
    let s = null;
    for (const i of this.gaps) {
      const r = this.xOf(i.t0), o = this.xOf(i.t1);
      if (o - r < 3 || t < r || t > o) continue;
      const a = this.lanes[i.laneIdx], l = _ - this.scrollY + a.y, c = a.rows * lt;
      n < l || n > l + c || (!s || i.dur < s.dur) && (s = i);
    }
    return s;
  }
  clampScroll() {
    const t = Math.max(0, this.contentH - (this.cssH - _));
    this.scrollY = j(this.scrollY, 0, t);
  }
  emitRange(t) {
    this.rangeTimer && clearTimeout(this.rangeTimer);
    const n = () => this.cb.onRangeChange?.(this.toReal(this.target.begin), this.toReal(this.target.end));
    t ? n() : this.rangeTimer = window.setTimeout(n, vo);
  }
  // Pixels actually drawn across; the server folds anything narrower than one.
  // The canvas may be unsized when hidden (e.g. the timeline tab is not the
  // active view yet), so fall back to the parent width or the window width so
  // callers like the overview density never collapse to a single bucket.
  viewportWidth() {
    const t = this.canvas.width || Math.round(this.cssW * this.dpr);
    if (t > 1) return t;
    const n = window.devicePixelRatio || 1, s = this.canvas.parentElement?.clientWidth ?? 0;
    return Math.max(1, Math.round((s || window.innerWidth) * n));
  }
  // --- render loop -----------------------------------------------------------
  resize() {
    const t = this.canvas.parentElement, n = t ? t.clientWidth : this.canvas.clientWidth, s = t ? t.clientHeight : this.canvas.clientHeight;
    this.dpr = window.devicePixelRatio || 1, this.cssW = n, this.cssH = s, this.canvas.width = Math.round(n * this.dpr), this.canvas.height = Math.round(s * this.dpr), this.canvas.style.width = `${n}px`, this.canvas.style.height = `${s}px`, this.clampScroll(), this.resizeMini(), this.resizeCounters(), this.invalidate();
  }
  // --- Minimap / overview strip ---------------------------------------------
  attachMinimap(t) {
    this.mini = t;
    const n = t.getContext("2d");
    if (!n) return;
    this.miniCtx = n, t.addEventListener("mousedown", this.onMiniDown), window.addEventListener("mousemove", this.onMiniMove), window.addEventListener("mouseup", this.onMiniUp), new ResizeObserver(() => this.resizeMini()).observe(t.parentElement ?? t), this.resizeMini();
  }
  resizeMini() {
    const t = this.mini;
    if (!t) return;
    const n = t.parentElement, s = n ? n.clientWidth : t.clientWidth, i = n ? n.clientHeight : t.clientHeight;
    this.miniW = s, this.miniH = i, t.width = Math.round(s * this.dpr), t.height = Math.round(i * this.dpr), t.style.width = `${s}px`, t.style.height = `${i}px`, this.invalidate();
  }
  computeMiniActivity() {
    const t = new Array(kt).fill(0), n = this.totalSpan || 1;
    for (const i of this.slices) {
      const r = j(Math.floor(i.ts / n * kt), 0, kt - 1);
      t[r] += i.total;
    }
    let s = 1;
    for (const i of t) i > s && (s = i);
    this.miniActivity = t, this.miniActivityMax = s;
  }
  // Whole-trace per-lane activity (density blocks over [0, totalSpan]) so the
  // minimap mirrors the track stack (grouping + where each process is busy).
  setOverview(t) {
    const n = /* @__PURE__ */ new Map(), s = this.totalSpan || 1;
    let i = 1;
    for (const o of t) {
      const a = `${o.pid}/${o.tid}`;
      let l = n.get(a);
      l || (l = new Float64Array(kt), n.set(a, l));
      const c = j(Math.floor(o.ts / s * kt), 0, kt - 1);
      l[c] += o.total || o.count || 0, l[c] > i && (i = l[c]);
    }
    const r = /* @__PURE__ */ new Map();
    for (const o of t) r.set(o.pid, (r.get(o.pid) ?? 0) + (o.count || 0));
    this.ovOpsByPid = r, this.overviewLanes = n, this.overviewMax = i, this.invalidate();
  }
  // Per-process I/O busy time (us), from the proctree scan.
  setIoBusy(t) {
    this.ioBusyByPid = t, this.invalidate();
  }
  renderMinimap() {
    const t = this.miniCtx;
    if (!t) return;
    if (t.save(), t.scale(this.dpr, this.dpr), t.clearRect(0, 0, this.miniW, this.miniH), t.fillStyle = this.th.plotBg, t.fillRect(0, 0, this.miniW, this.miniH), this.overviewLanes.size > 0)
      this.renderMiniLanes(t);
    else {
      const r = this.miniActivity.length, o = this.miniW / r;
      t.fillStyle = this.th.ruler;
      for (let a = 0; a < r; a++) {
        const l = this.miniActivity[a] / this.miniActivityMax;
        if (l <= 0) continue;
        const c = Math.max(1, l * (this.miniH - 4));
        t.fillRect(a * o, this.miniH - 2 - c, Math.max(1, o), c);
      }
    }
    const n = this.live.begin / this.totalSpan * this.miniW, s = this.live.end / this.totalSpan * this.miniW, i = Math.max(2, s - n);
    if (t.fillStyle = this.th.selFill, t.fillRect(n, 0, i, this.miniH), t.strokeStyle = this.th.selStroke, t.lineWidth = 1, t.strokeRect(n + 0.5, 0.5, i - 1, this.miniH - 1), this.miniSel) {
      const r = this.miniSel.t0 / this.totalSpan * this.miniW, o = this.miniSel.t1 / this.totalSpan * this.miniW, a = Math.max(1, o - r);
      t.fillStyle = this.th.selFill, t.fillRect(r, 0, a, this.miniH), t.strokeStyle = this.th.selStroke, t.strokeRect(r + 0.5, 0.5, a - 1, this.miniH - 1);
    }
    t.restore();
  }
  // A scaled-down heatmap of the track stack: one thin row per lane in the same
  // fork-DFS order (with process gaps), activity intensity along time.
  renderMiniLanes(t) {
    const n = (m) => this.procOrder.get(m) ?? 1e9 + m, s = [...this.overviewLanes.keys()].sort((m, k) => {
      const [E, x] = m.split("/").map(Number), [y, R] = k.split("/").map(Number);
      return n(E) - n(y) || x - R;
    }), i = s.length;
    if (i === 0) return;
    const r = 1, o = this.miniH - 1;
    if (i > o - r) {
      this.renderMiniAggregate(t, r, o);
      return;
    }
    const a = new Array(i);
    let l = 0, c = "";
    for (let m = 0; m < i; m++) {
      const k = s[m].slice(0, s[m].indexOf("/")), E = m > 0 && k !== c;
      a[m] = E, E && l++, c = k;
    }
    const u = i <= 48 ? 1 : 0, h = Math.max(1, (o - r - l * u) / i), v = this.miniW / kt, g = Math.log(this.overviewMax + 1) || 1;
    let p = r;
    for (let m = 0; m < i; m++) {
      a[m] && (p += u);
      const k = this.overviewLanes.get(s[m]);
      t.fillStyle = this.th.miniIdle, t.fillRect(0, p, this.miniW, h);
      for (let E = 0; E < kt; E++) {
        const x = k[E];
        if (x <= 0) continue;
        const y = Math.log(x + 1) / g;
        t.fillStyle = `rgba(${this.th.miniActivity},${0.25 + 0.65 * Math.min(1, y)})`, t.fillRect(E * v, p, Math.max(1, v), h);
      }
      p += h;
    }
  }
  // Too many lanes to give each a visible row: collapse to a single time-density
  // heatmap (activity summed across all lanes per column), always fully visible.
  renderMiniAggregate(t, n, s) {
    const i = new Float64Array(kt);
    let r = 1;
    for (const c of this.overviewLanes.values())
      for (let u = 0; u < kt; u++)
        i[u] += c[u], i[u] > r && (r = i[u]);
    const o = this.miniW / kt, a = Math.log(r + 1) || 1, l = s - n;
    t.fillStyle = this.th.miniIdle, t.fillRect(0, n, this.miniW, l);
    for (let c = 0; c < kt; c++) {
      if (i[c] <= 0) continue;
      const u = Math.min(1, Math.log(i[c] + 1) / a), h = Math.max(1, u * l);
      t.fillStyle = `rgba(${this.th.miniActivity},${0.35 + 0.55 * u})`, t.fillRect(c * o, s - h, Math.max(1, o), h);
    }
  }
  miniTimeAt(t) {
    if (!this.mini) return 0;
    const n = this.mini.getBoundingClientRect();
    return j(t.clientX - n.left, 0, this.miniW) / this.miniW * this.totalSpan;
  }
  centerViewportAt(t) {
    const n = this.target.end - this.target.begin, s = j(t - n / 2, 0, Math.max(0, this.totalSpan - n));
    this.target = { begin: s, end: s + n }, this.invalidate(), this.emitRange(!1);
  }
  // --- Counter track (bandwidth) --------------------------------------------
  attachCounters(t) {
    this.counterCanvas = t;
    const n = t.getContext("2d");
    if (!n) return;
    this.counterCtx = n, new ResizeObserver(() => this.resizeCounters()).observe(t.parentElement ?? t), this.resizeCounters();
  }
  resizeCounters() {
    const t = this.counterCanvas;
    if (!t) return;
    const n = t.parentElement, s = n ? n.clientWidth : t.clientWidth, i = n ? n.clientHeight : t.clientHeight;
    this.counterW = s, this.counterH = i, t.width = Math.round(s * this.dpr), t.height = Math.round(i * this.dpr), t.style.width = `${s}px`, t.style.height = `${i}px`, this.invalidate();
  }
  setCounters(t, n, s, i) {
    this.counters = { begin: t, bucketUs: n, read: s, write: i };
    const r = n > 0 ? 1e6 / n : 0;
    let o = 1;
    for (let a = 0; a < s.length; a++) {
      const l = (s[a] + i[a]) * r;
      l > o && (o = l);
    }
    this.counterPeak = o, this.invalidate();
  }
  // Dock a per-pid counter split as lane-background heat. `color` is the
  // counter's overlay color; `max` the global peak for normalization.
  setLaneCounter(t, n, s, i, r, o) {
    this.laneCounter = { begin: t, bucketUs: n, buckets: s, byPid: i, max: o, ramp: this.buildRamp(r) }, this.invalidate();
  }
  clearLaneCounter() {
    this.laneCounter = null, this.invalidate();
  }
  // Sequential single-hue ramp: panel background (empty) -> the counter color.
  buildRamp(t) {
    const n = Nn(this.th.panelBg), s = Nn(t), i = [];
    for (let r = 0; r < ke; r++) {
      const o = r / (ke - 1), a = Math.round(n[0] + (s[0] - n[0]) * o), l = Math.round(n[1] + (s[1] - n[1]) * o), c = Math.round(n[2] + (s[2] - n[2]) * o);
      i.push(`rgb(${a},${l},${c})`);
    }
    return i;
  }
  // Background heat behind each process lane: per-bucket cell tinted by the
  // docked counter's value, drawn after the lane stripe and under the slices.
  renderLaneCounters(t) {
    const n = this.laneCounter;
    if (!n || n.max <= 0) return;
    t.save(), t.beginPath(), t.rect(D, _, this.cssW - D, this.cssH - _), t.clip();
    const s = n.buckets, i = (o) => this.xOf(n.begin + (o + 0.5) * n.bucketUs), r = this.plotW() / Math.max(s, 1);
    for (const o of this.lanes) {
      if (o.kind === "host") continue;
      const a = n.byPid.get(o.pid);
      if (!a) continue;
      const l = _ - this.scrollY + o.y, c = o.rows * lt;
      if (!(l + c < _ || l > this.cssH))
        for (let u = 0; u < s; u++) {
          const h = a[u];
          if (h <= 0) continue;
          const v = i(u), g = u + 1 < s ? i(u + 1) : v + r;
          if (g < D || v > this.cssW) continue;
          const p = j(
            Math.round(Math.sqrt(h / n.max) * (ke - 1)),
            0,
            ke - 1
          );
          t.fillStyle = n.ramp[p];
          const m = Math.max(v, D);
          t.fillRect(m, l, Math.max(1, Math.min(g, this.cssW) - m), c);
        }
    }
    t.restore();
  }
  renderCounters() {
    const t = this.counterCtx;
    if (!t) return;
    const n = this.counterH;
    t.save(), t.scale(this.dpr, this.dpr), t.clearRect(0, 0, this.counterW, n), t.fillStyle = this.th.plotBg, t.fillRect(0, 0, this.counterW, n);
    const s = this.counters, i = this.live.end - this.live.begin;
    if (s && s.bucketUs > 0 && i > 0) {
      const o = 1e6 / s.bucketUs, a = n - 4;
      t.save(), t.beginPath(), t.rect(D, 0, this.counterW - D, n), t.clip();
      const l = [];
      for (let u = 0; u < s.read.length; u++) {
        const h = s.begin + (u + 0.5) * s.bucketUs, v = this.xOf(h);
        if (v < D - 4 || v > this.counterW + 4) continue;
        const g = s.read[u] * o / this.counterPeak * a, p = s.write[u] * o / this.counterPeak * a;
        l.push({ x: v, rt: n - g, tt: n - g - p });
      }
      const c = (u, h) => {
        if (l.length < 2) return;
        t.beginPath(), t.moveTo(l[0].x, n), t.lineTo(l[0].x, u(l[0]));
        for (let g = 1; g < l.length - 1; g++) {
          const p = (l[g].x + l[g + 1].x) / 2, m = (u(l[g]) + u(l[g + 1])) / 2;
          t.quadraticCurveTo(l[g].x, u(l[g]), p, m);
        }
        const v = l[l.length - 1];
        t.lineTo(v.x, u(v)), t.lineTo(v.x, n), t.closePath(), t.fillStyle = h, t.fill();
      };
      c((u) => u.tt, this.th.write), c((u) => u.rt, this.th.read), t.restore();
    }
    t.fillStyle = this.th.plotBg, t.fillRect(0, 0, D, n), t.strokeStyle = this.th.divider, t.beginPath(), t.moveTo(D - 0.5, 0), t.lineTo(D - 0.5, n), t.moveTo(0, n - 0.5), t.lineTo(this.counterW, n - 0.5), t.stroke(), t.fillStyle = this.th.counterLabel, t.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif', t.textBaseline = "top", t.fillText("I/O BANDWIDTH", 8, 4), t.fillStyle = this.th.laneText, t.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace", t.textAlign = "right", t.fillText(In(this.counterPeak), D - 8, 5), t.textAlign = "left";
    const r = n - 6;
    t.fillStyle = this.th.read, t.fillRect(8, r - 4, 8, 8), t.fillStyle = this.th.write, t.fillRect(58, r - 4, 8, 8), t.fillStyle = this.th.laneText, t.textBaseline = "middle", t.fillText("read", 20, r), t.fillText("write", 70, r), t.restore();
  }
  // Render-on-demand: a frame is only scheduled while something is animating
  // (easing, held keys, pending zoom) or after an explicit invalidate(). When
  // idle, no rAF runs at all, so the app uses ~0 CPU.
  requestFrame() {
    this.frameScheduled || (this.frameScheduled = !0, this.raf = requestAnimationFrame(this.frame));
  }
  invalidate() {
    this._dirty = !0, this.requestFrame();
  }
  render() {
    const t = this.ctx;
    t.save(), t.scale(this.dpr, this.dpr), t.clearRect(0, 0, this.cssW, this.cssH), t.fillStyle = this.th.panelBg, t.fillRect(0, 0, this.cssW, this.cssH), this.renderLanes(t), this.renderLaneCounters(t), this.renderGridlines(t), this.renderSlices(t), this.renderSpawnArrows(t), this.renderGaps(t), this.renderBreaks(t), this.renderSelection(t), this.renderRuler(t), this.renderGutter(t), this.renderCrosshair(t), t.restore();
  }
  // Spawn-connector arrows for the selected process's lineage: from the parent
  // clone to the child, drawn only on selection to avoid flow-arrow clutter.
  renderSpawnArrows(t) {
    if (this.procParent.size === 0) return;
    const n = /* @__PURE__ */ new Map();
    for (const l of this.lanes) {
      const c = Number(l.pid);
      n.has(c) || n.set(c, l);
    }
    const s = (l) => _ - this.scrollY + l.y + l.rows * lt, i = (l) => _ - this.scrollY + l.y, r = this.selected ? Number(this.selected.pid) : null, o = (l) => r != null && (l === r || this.procParent.get(l) === r || this.procParent.get(r) === l), a = (l, c) => {
      const u = this.procParent.get(l), h = this.procSpawn.get(l);
      if (u == null || u < 0 || h == null || h <= 0) return;
      const v = n.get(u), g = n.get(l);
      if (!v || !g) return;
      const p = this.procFirst.get(l) ?? h, m = this.xOf(h), k = this.xOf(p);
      if (m < D && k < D || m > this.cssW && k > this.cssW) return;
      const E = s(v), x = i(g);
      t.strokeStyle = c ? this.th.accent : this.th.accentSoft, t.fillStyle = t.strokeStyle, t.lineWidth = c ? 1.5 : 1, t.beginPath(), t.moveTo(m, E), t.bezierCurveTo(m, (E + x) / 2, k, (E + x) / 2, k, x), t.stroke(), c && (t.beginPath(), t.moveTo(k, x), t.lineTo(k - 4, x - 6), t.lineTo(k + 4, x - 6), t.closePath(), t.fill());
    };
    for (const [l] of this.procParent) o(l) || a(l, !1);
    for (const [l] of this.procParent) o(l) && a(l, !0);
  }
  // Vertical cursor line plus a time readout pinned in the ruler.
  renderCrosshair(t) {
    if (!this.cursorInside || this.dragging || this.selecting) return;
    const n = Math.round(this.mouseX) + 0.5;
    t.strokeStyle = this.th.crosshair, t.lineWidth = 1, t.setLineDash([3, 3]), t.beginPath(), t.moveTo(n, _), t.lineTo(n, this.cssH), t.stroke(), t.setLineDash([]);
    const s = Zt(this.toReal(this.timeOf(this.mouseX)));
    t.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    const i = t.measureText(s).width + 8, r = j(this.mouseX - i / 2, D, this.cssW - i);
    t.fillStyle = this.th.groupText, t.fillRect(r, _ - 15, i, 14), t.fillStyle = this.th.plotBg, t.textBaseline = "middle", t.fillText(s, r + 4, _ - 8);
  }
  // Hatched markers at each compressed idle gap, labeled with the real time
  // skipped, so the discontinuous axis is never silent.
  renderBreaks(t) {
    if (this.timelapse)
      for (const n of this.runGaps) {
        const s = this.xdOf(this.toDisplay(n.begin)), i = this.xdOf(this.toDisplay(n.end));
        if (i < D || s > this.cssW) continue;
        const r = Math.max(D, s), o = Math.min(this.cssW, i);
        t.save(), t.beginPath(), t.rect(r, _, Math.max(1, o - r), this.cssH - _), t.clip(), t.strokeStyle = this.th.grid, t.lineWidth = 1, t.beginPath();
        for (let u = r - this.cssH; u < o + this.cssH; u += 6)
          t.moveTo(u, this.cssH), t.lineTo(u + this.cssH, _);
        t.stroke(), t.restore(), t.strokeStyle = this.th.accent, t.lineWidth = 1, t.setLineDash([4, 3]), t.beginPath(), t.moveTo(r + 0.5, _), t.lineTo(r + 0.5, this.cssH), t.moveTo(o - 0.5, _), t.lineTo(o - 0.5, this.cssH), t.stroke(), t.setLineDash([]);
        const a = `skip ${Zt(n.end - n.begin)}`;
        t.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace", t.textBaseline = "middle";
        const l = t.measureText(a).width + 8, c = j((r + o) / 2, D + l / 2, this.cssW - l / 2);
        t.fillStyle = this.th.plotBg, t.fillRect(c - l / 2, _ + 2, l, 13), t.strokeStyle = this.th.accent, t.strokeRect(c - l / 2 + 0.5, _ + 2.5, l - 1, 12), t.fillStyle = this.th.accent, t.textAlign = "center", t.fillText(a, c, _ + 9), t.textAlign = "left";
      }
  }
  // Tick positions shared by the gridlines and the ruler labels.
  timeTicks() {
    const t = this.live.end - this.live.begin, n = ho(t / this.plotW() * 90), s = Math.ceil(this.live.begin / n) * n;
    return { step: n, first: s };
  }
  // Vertical time gridlines, drawn BEHIND the slices so event blocks sit in
  // front of them (like Perfetto).
  renderGridlines(t) {
    const n = this.live.end - this.live.begin, s = this.plotW(), { step: i, first: r } = this.timeTicks();
    t.strokeStyle = this.th.grid, t.lineWidth = 1, t.beginPath();
    for (let o = r; o <= this.live.end; o += i) {
      const a = Math.round(D + (o - this.live.begin) / n * s) + 0.5;
      t.moveTo(a, _), t.lineTo(a, this.cssH);
    }
    t.stroke();
  }
  renderSelection(t) {
    if (!this.selection) return;
    const n = this.live.end - this.live.begin, s = this.plotW(), i = j(
      D + (this.selection.t0 - this.live.begin) / n * s,
      D,
      this.cssW
    ), r = j(
      D + (this.selection.t1 - this.live.begin) / n * s,
      D,
      this.cssW
    );
    t.fillStyle = this.th.selFill, t.fillRect(i, _, r - i, this.cssH - _), t.strokeStyle = this.th.selStroke, t.lineWidth = 1, t.beginPath(), t.moveTo(i + 0.5, _), t.lineTo(i + 0.5, this.cssH), t.moveTo(r - 0.5, _), t.lineTo(r - 0.5, this.cssH), t.stroke();
    const o = this.toReal(this.selection.t0), a = this.toReal(this.selection.t1), l = a - o, c = this.selBandwidth(o, a), u = `${Zt(o)} → ${Zt(a)}   ·   Δ ${Zt(l)}`, h = c > 0 ? `   ·   ${In(c)}` : "";
    t.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace", t.textBaseline = "middle";
    const v = 8, g = t.measureText(u).width, p = t.measureText(h).width, m = g + p + v * 2, k = j((i + r) / 2 - m / 2, D, this.cssW - m), E = _ + 3;
    t.fillStyle = this.th.plotBg, t.fillRect(k, E, m, 17), t.strokeStyle = this.th.accent, t.lineWidth = 1, t.strokeRect(k + 0.5, E + 0.5, m - 1, 16), t.fillStyle = this.th.numText, t.fillText(u, k + v, E + 9), t.fillStyle = this.th.accent, t.fillText(h, k + v + g, E + 9);
  }
  // Total read+write bytes in [t0, t1] over the wall time, as bytes/sec.
  selBandwidth(t, n) {
    const s = this.counters;
    if (!s || !s.bucketUs || n <= t) return 0;
    let i = 0;
    const r = Math.min(s.read.length, s.write.length);
    for (let o = 0; o < r; o++) {
      const a = s.begin + o * s.bucketUs, l = a + s.bucketUs;
      if (l <= t || a >= n) continue;
      const c = (Math.min(l, n) - Math.max(a, t)) / s.bucketUs;
      i += ((s.read[o] || 0) + (s.write[o] || 0)) * c;
    }
    return i / ((n - t) / 1e6);
  }
  renderLanes(t) {
    for (let n = 0; n < this.lanes.length; n++) {
      const s = this.lanes[n], i = _ - this.scrollY + s.y, r = s.rows * lt;
      i + r < _ || i > this.cssH || (t.fillStyle = n % 2 === 0 ? this.th.laneAlt : this.th.panelBg, t.fillRect(0, i, this.cssW, r));
    }
  }
  renderSlices(t) {
    t.save(), t.beginPath(), t.rect(D, _, this.cssW - D, this.cssH - _), t.clip(), t.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace", t.textBaseline = "middle";
    for (const n of this.slices) {
      const s = this.xOf(n.ts), i = Math.max(this.xOf(n.ts + n.dur) - s, 1);
      if (s + i < D || s > this.cssW) continue;
      const r = this.lanes[n.laneIdx], o = _ - this.scrollY + r.y + n.depth * lt;
      if (o + lt < _ || o > this.cssH) continue;
      const a = this.metricFill(n) ?? Rn(_n(n.ev)), l = Math.max(s, D), c = Math.min(s + i, this.cssW) - l, u = this.searchTerm !== "" && !this.searchMatchSet.has(n);
      if (n.density ? (t.globalAlpha = u ? 0.12 : 0.55, t.fillStyle = a, t.fillRect(l, o + 3, c, lt - 6), t.globalAlpha = 1) : (t.globalAlpha = u ? 0.15 : 1, t.fillStyle = a, t.fillRect(l, o + 1, c, lt - 2), t.globalAlpha = 1), n === this.hovered && (t.strokeStyle = this.th.accent, t.lineWidth = 1, t.strokeRect(l + 0.5, o + 1.5, c - 1, lt - 3)), n.ev === this.selected && (t.strokeStyle = this.th.accent, t.lineWidth = 2, t.strokeRect(l + 1, o + 2, c - 2, lt - 4)), !n.density && i > 32) {
        t.fillStyle = oo(a);
        const h = String(n.ev.name ?? "");
        t.save(), t.beginPath(), t.rect(l, o, c - 4, lt), t.clip(), t.fillText(h, l + 4, o + lt / 2), t.restore();
      }
    }
    t.restore();
  }
  renderRuler(t) {
    t.fillStyle = this.th.plotBg, t.fillRect(0, 0, this.cssW, _), t.strokeStyle = this.th.divider, t.lineWidth = 1, t.beginPath(), t.moveTo(0, _ - 0.5), t.lineTo(this.cssW, _ - 0.5), t.stroke(), t.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace", t.fillStyle = this.th.ruler, t.textBaseline = "middle", t.textAlign = "left", t.fillText("TRACK", 12, _ / 2), t.fillText("I/O UTIL", oe, _ / 2), t.textAlign = "right", t.fillText("OPS", Fn, _ / 2), t.fillText("BYTES", Xe, _ / 2), t.textAlign = "left";
    const n = this.live.end - this.live.begin, s = this.plotW(), { step: i, first: r } = this.timeTicks();
    t.fillStyle = this.th.laneText, t.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace", t.textBaseline = "middle";
    for (let o = r; o <= this.live.end; o += i) {
      const a = D + (o - this.live.begin) / n * s;
      t.strokeStyle = this.th.divider, t.beginPath(), t.moveTo(a + 0.5, _ - 6), t.lineTo(a + 0.5, _), t.stroke(), t.fillText(ao(this.toReal(o), i), a + 3, _ / 2);
    }
  }
  // Elbow connectors in the gutter linking each child process's accent bar up
  // to its parent (a vertical spine at the parent's indent + a horizontal tick).
  renderGutter(t) {
    t.fillStyle = this.th.plotBg, t.fillRect(0, _, D, this.cssH - _), t.strokeStyle = this.th.divider, t.beginPath(), t.moveTo(D - 0.5, 0), t.lineTo(D - 0.5, this.cssH), t.stroke();
    for (const n of this.lanes) {
      const s = _ - this.scrollY + n.y, i = n.rows * lt, r = Math.max(s, _), o = Math.min(s + i, this.cssH);
      if (o <= _ || r >= this.cssH) continue;
      const a = j(s + lt / 2, _ + lt / 2, this.cssH - 2);
      n.kind === "host" && (t.fillStyle = this.th.groupBand, t.fillRect(0, r, D - 1, o - r));
      const l = this.collapsed.has(n.collapseKey);
      n.collapsible && (t.fillStyle = this.th.ruler, t.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace", t.textBaseline = "middle", t.textAlign = "left", t.fillText(l ? ">" : "v", n.indent + 2, a)), n.kind === "proc" && (t.fillStyle = Rn("proc:" + n.pid), t.fillRect(n.indent + xe - 2, r, 2, o - r));
      const c = n.indent + xe + (n.kind === "thread" ? 2 : 4);
      t.save(), t.beginPath(), t.rect(c, r, oe - c - 8, o - r), t.clip(), t.textBaseline = "middle", t.textAlign = "left", n.kind === "host" ? (t.fillStyle = this.th.groupText, t.font = "600 11px ui-monospace, SFMono-Regular, Menlo, monospace") : n.kind === "proc" ? (t.fillStyle = this.th.laneText, t.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace") : (t.fillStyle = this.th.numText, t.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace"), t.fillText(n.label, c, a), t.restore(), n.kind !== "thread" && this.renderLaneColumns(t, n, a);
    }
  }
  renderLaneColumns(t, n, s) {
    const i = this.totalSpan || 1, r = i / 1e6;
    let o = 0, a = 0;
    const l = (g) => {
      o += this.ovOpsByPid.get(g) ?? 0, a += this.bytesByPid.get(g) ?? 0;
    };
    let c = 0, u = 0;
    if (n.kind === "host") {
      const g = [];
      for (const p of this.hostPids.get(n.host) ?? [])
        l(p), g.push(j((this.ioBusyByPid.get(p) ?? 0) / i, 0, 1));
      g.length && (c = g.reduce((p, m) => p + m, 0) / g.length, u = Math.sqrt(g.reduce((p, m) => p + (m - c) ** 2, 0) / g.length));
    } else {
      const g = Number(n.pid);
      l(g), c = j((this.ioBusyByPid.get(g) ?? 0) / i, 0, 1);
    }
    const h = 6;
    t.fillStyle = this.th.divider, t.fillRect(oe, s - h / 2, Ye, h), t.fillStyle = c > 0.8 ? this.th.gapStroke : this.th.accent, t.fillRect(oe, s - h / 2, Ye * c, h), t.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace", t.textBaseline = "middle", t.textAlign = "left", t.fillStyle = this.th.numText;
    const v = n.kind === "host" ? `${Math.round(c * 100)}%±${Math.round(u * 100)}%` : `${Math.round(c * 100)}%`;
    t.fillText(v, oe + Ye + 5, s), t.textAlign = "right", t.fillText(co(o / r), Fn, s), a > 0 ? t.fillText(lo(a), Xe, s) : (t.fillStyle = this.th.ruler, t.fillText("-", Xe, s)), t.textAlign = "left";
  }
  // The collapsible gutter row under a gutter click, or null.
  gutterRowAt(t) {
    for (const n of this.lanes) {
      if (!n.collapsible) continue;
      const s = _ - this.scrollY + n.y;
      if (t >= s && t <= s + lt) return n;
    }
    return null;
  }
}
const Es = Ws();
function Cs() {
  const e = Hs(Es);
  if (!e) throw new Error("TraceSourceContext not provided");
  return e;
}
var So = /* @__PURE__ */ ut("<button type=button class=cheat-dock>tracks"), Mo = /* @__PURE__ */ ut("<div class=cheat><div class=cheat-bar><span class=cheat-title>·</span><div class=cheat-dims><button type=button>per pid</button><button type=button>per node</button></div><div class=cheat-dims><button type=button>heatmap</button><button type=button>band</button></div><span class=cheat-count> </span><span class=cheat-read></span><button type=button class=cheat-close title=collapse>x</button></div><div class=cheat-plot><div class=cheat-labels></div><canvas class=cheat-canvas>"), xo = /* @__PURE__ */ ut("<b>"), ko = /* @__PURE__ */ ut("<span class=cheat-band-label>p10-p90 · median"), Ao = /* @__PURE__ */ ut("<span class=cheat-label>");
const To = 16, Lo = 7, Bo = 224, $o = 130, Dt = [10, 11, 10], Hn = 6, Ro = (e) => {
  const t = parseInt(e.slice(1), 16);
  return [t >> 16 & 255, t >> 8 & 255, t & 255];
}, Ne = 24;
function Un(e) {
  const t = Ro(e), n = [];
  for (let s = 0; s < Ne; s++) {
    const i = s / (Ne - 1), r = Math.round(Dt[0] + (t[0] - Dt[0]) * i), o = Math.round(Dt[1] + (t[1] - Dt[1]) * i), a = Math.round(Dt[2] + (t[2] - Dt[2]) * i);
    n.push(`rgb(${r},${o},${a})`);
  }
  return n;
}
const zn = (e, t) => e.endsWith("_pct") ? `${t.toFixed(1)}%` : e === "size" ? t >= 1e9 ? `${(t / 1e9).toFixed(2)} GB` : `${(t / 1e6).toFixed(1)} MB` : e === "dur" ? t >= 1e6 ? `${(t / 1e6).toFixed(1)} s` : `${(t / 1e3).toFixed(1)} ms` : Math.abs(t) >= 1e3 ? t.toLocaleString(void 0, {
  maximumFractionDigits: 0
}) : t.toFixed(2);
function _o(e) {
  const n = Cs().counterSplit(() => e.end > e.begin ? {
    begin: e.begin,
    end: e.end,
    series: e.seriesId,
    dim: e.dim,
    width: 700,
    top: 24
  } : null), [s, i] = gt(null), [r, o] = gt("heatmap"), [a, l] = gt(/* @__PURE__ */ new Set());
  let c, u, h = Un(e.color);
  de(() => {
    h = Un(e.color);
  });
  const v = () => {
    const f = n()?.entities.length ?? 1;
    return Math.max(Lo, Math.min(To, Math.floor(Bo / Math.max(f, 1))));
  }, g = () => r() === "band" ? $o : Math.max((n()?.entities.length ?? 0) * v(), v()), p = (f, w, A) => {
    const $ = f.buckets;
    let I = 0;
    for (let W = $ - 1; I < W; ) {
      const O = I + W >> 1;
      w(O) < -Hn ? I = O + 1 : W = O;
    }
    let F = $ - 1;
    for (let W = 0; W < F; ) {
      const O = W + F + 1 >> 1;
      w(O) > A + Hn ? F = O - 1 : W = O;
    }
    return {
      lo: Math.max(0, I - 1),
      hi: Math.min($ - 1, F + 1)
    };
  }, m = (f, w, A, $, I, F) => {
    const W = v(), O = w.buckets;
    let N = 1e-9;
    for (const P of w.entities) P.max > N && (N = P.max);
    for (let P = 0; P < w.entities.length; P++) {
      const it = w.entities[P], rt = P * W;
      for (let ft = I; ft <= F; ft++) {
        const mt = it.values[ft];
        if (mt <= 0) continue;
        const Bt = Math.sqrt(mt / N), vt = Math.min(Ne - 1, Math.max(0, Math.round(Bt * (Ne - 1)))), wt = $(ft), Tt = ft + 1 < O ? $(ft + 1) : wt + A / O;
        f.fillStyle = h[vt], f.fillRect(wt, rt, Math.max(1, Tt - wt), W - (W > 9 ? 1 : 0));
      }
      a().has(it.entity) && (f.fillStyle = "#e6e2ce", f.fillRect(0, rt, 2, W));
    }
    const S = s();
    S && S.row >= 0 && S.row < w.entities.length && (f.strokeStyle = "rgba(230,161,60,0.7)", f.lineWidth = 1, f.strokeRect(0.5, S.row * W + 0.5, A - 1, W - 1));
  }, k = (f, w, A, $, I, F) => {
    const W = w.band;
    if (!W) return;
    let O = 1e-9;
    for (let S = 0; S < w.buckets; S++) W.p90[S] > O && (O = W.p90[S]);
    for (const S of w.entities) a().has(S.entity) && S.max > O && (O = S.max);
    const N = (S) => A - S / O * (A - 2) - 1;
    f.beginPath();
    for (let S = I; S <= F; S++) f.lineTo($(S), N(W.p90[S]));
    for (let S = F; S >= I; S--) f.lineTo($(S), N(W.p10[S]));
    f.closePath(), f.globalAlpha = 0.16, f.fillStyle = e.color, f.fill(), f.globalAlpha = 1, f.beginPath();
    for (let S = I; S <= F; S++) {
      const P = $(S), it = N(W.p50[S]);
      S === I ? f.moveTo(P, it) : f.lineTo(P, it);
    }
    f.strokeStyle = e.color, f.lineWidth = 1.5, f.stroke();
    for (const S of w.entities)
      if (a().has(S.entity)) {
        f.beginPath();
        for (let P = I; P <= F; P++) {
          const it = $(P), rt = N(S.values[P]);
          P === I ? f.moveTo(it, rt) : f.lineTo(it, rt);
        }
        f.strokeStyle = "#e6e2ce", f.lineWidth = 1, f.stroke();
      }
  }, E = () => {
    const f = n(), w = c;
    if (!f || !w || f.entities.length === 0) return;
    const A = w.clientWidth || 0, $ = g();
    if (A <= 0 || $ <= 0) return;
    const I = window.devicePixelRatio || 1, F = Math.max(1, Math.round(A * I)), W = Math.max(1, Math.round($ * I));
    w.width !== F && (w.width = F), w.height !== W && (w.height = W), w.style.height = `${$}px`;
    const O = w.getContext("2d");
    if (!O) return;
    O.setTransform(I, 0, 0, I, 0, 0), O.fillStyle = `rgb(${Dt[0]},${Dt[1]},${Dt[2]})`, O.fillRect(0, 0, A, $);
    const N = (rt) => e.frac(f.begin + (rt + 0.5) * f.bucket_us) * A, {
      lo: S,
      hi: P
    } = p(f, N, A);
    r() === "band" ? k(O, f, $, N, S, P) : m(O, f, A, N, S, P);
    const it = s();
    if (it) {
      const rt = Math.round(it.frac * A) + 0.5;
      O.strokeStyle = "rgba(200,200,200,0.5)", O.beginPath(), O.moveTo(rt, 0), O.lineTo(rt, $), O.stroke();
    }
  };
  de(() => {
    e.tick(), n(), s(), r(), a(), E();
  }), sn(() => {
    if (!u) return;
    const f = new ResizeObserver(() => E());
    f.observe(u), pe(() => f.disconnect());
  });
  const x = (f) => {
    if (!c) return;
    const w = c.getBoundingClientRect();
    if (w.width <= 0 || w.height <= 0) return;
    const A = Math.max(0, Math.min(1, (f.clientX - w.left) / w.width)), $ = Math.floor((f.clientY - w.top) / w.height * (n()?.entities.length ?? 1));
    i({
      row: $,
      frac: A
    });
  }, y = (f) => {
    const w = n();
    if (!c || !w) return -1;
    const A = c.getBoundingClientRect();
    return A.height <= 0 ? -1 : Math.floor((f - A.top) / A.height * w.entities.length);
  }, R = (f) => {
    if (r() !== "heatmap") return;
    const w = n();
    if (!w) return;
    const A = w.entities[y(f.clientY)];
    !A || A.entity === "__other__" || l(($) => {
      const I = new Set($);
      return I.has(A.entity) ? I.delete(A.entity) : I.add(A.entity), I;
    });
  }, T = () => {
    const f = n(), w = s();
    if (!f || !w) return null;
    const A = e.realAtFrac(w.frac), $ = Math.max(0, Math.min(f.buckets - 1, Math.round((A - f.begin) / f.bucket_us - 0.5)));
    if (r() === "band") {
      const I = f.band;
      return I ? {
        label: "median",
        v: I.p50[$],
        hi: I.p90[$]
      } : null;
    }
    return w.row < 0 || w.row >= f.entities.length ? null : {
      label: f.entities[w.row].label,
      v: f.entities[w.row].values[$] ?? 0
    };
  };
  return (() => {
    var f = Mo(), w = f.firstChild, A = w.firstChild, $ = A.firstChild, I = A.nextSibling, F = I.firstChild, W = F.nextSibling, O = I.nextSibling, N = O.firstChild, S = N.nextSibling, P = O.nextSibling, it = P.firstChild, rt = P.nextSibling, ft = rt.nextSibling, mt = w.nextSibling, Bt = mt.firstChild, vt = Bt.nextSibling, wt = u;
    typeof wt == "function" ? te(wt, f) : u = f, G(A, () => e.name, $), G(A, () => e.key_, null), F.$$click = () => e.onDim("pid"), W.$$click = () => e.onDim("node"), N.$$click = () => o("heatmap"), S.$$click = () => o("band"), G(P, () => n()?.total_entities ?? 0, it), G(P, () => e.dim === "pid" ? "procs" : "nodes", null), G(rt, () => {
      const U = T();
      return U ? [(() => {
        var tt = xo();
        return G(tt, () => U.label), tt;
      })(), " ", jt(() => zn(e.key_, U.v)), jt(() => jt(() => U.hi != null)() ? [" · p90 ", jt(() => zn(e.key_, U.hi))] : null)] : null;
    }), G(w, nt(Rt, {
      get when() {
        return jt(() => !!e.onDock)() && e.dim === "pid";
      },
      get children() {
        var U = So();
        return U.$$click = () => e.onDock?.(), yt((tt) => {
          var q = !!e.docked, dt = e.docked ? "remove from tracks" : "show behind track lanes";
          return q !== tt.e && U.classList.toggle("on", tt.e = q), dt !== tt.t && Ie(U, "title", tt.t = dt), tt;
        }, {
          e: void 0,
          t: void 0
        }), U;
      }
    }), ft), ft.$$click = () => e.onClose(), G(Bt, nt(Rt, {
      get when() {
        return r() === "heatmap";
      },
      get fallback() {
        return ko();
      },
      get children() {
        return (n()?.entities ?? []).map((U) => (() => {
          var tt = Ao();
          return G(tt, (() => {
            var q = jt(() => v() >= 11);
            return () => q() ? U.label : "";
          })()), yt((q) => {
            var dt = !!a().has(U.entity), Mt = `${v()}px`, d = U.label;
            return dt !== q.e && tt.classList.toggle("pinned", q.e = dt), Mt !== q.t && Pt(tt, "height", q.t = Mt), d !== q.a && Ie(tt, "title", q.a = d), q;
          }, {
            e: void 0,
            t: void 0,
            a: void 0
          }), tt;
        })());
      }
    })), vt.$$click = R, vt.addEventListener("mouseleave", () => i(null)), vt.$$mousemove = x;
    var Tt = c;
    return typeof Tt == "function" ? te(Tt, vt) : c = vt, yt((U) => {
      var tt = e.color, q = e.dim === "pid", dt = e.dim === "node", Mt = r() === "heatmap", d = r() === "band", M = `${g()}px`, L = `0 0 ${e.gutter}px`, C = r() === "heatmap";
      return tt !== U.e && Pt(A, "color", U.e = tt), q !== U.t && F.classList.toggle("on", U.t = q), dt !== U.a && W.classList.toggle("on", U.a = dt), Mt !== U.o && N.classList.toggle("on", U.o = Mt), d !== U.i && S.classList.toggle("on", U.i = d), M !== U.n && Pt(mt, "height", U.n = M), L !== U.s && Pt(Bt, "flex", U.s = L), C !== U.h && vt.classList.toggle("clickable", U.h = C), U;
    }, {
      e: void 0,
      t: void 0,
      a: void 0,
      o: void 0,
      i: void 0,
      n: void 0,
      s: void 0,
      h: void 0
    }), f;
  })();
}
es(["click", "mousemove"]);
var Io = /* @__PURE__ */ ut("<span class=cstat><b>"), Eo = /* @__PURE__ */ ut("<span class=cstat><span>min <b></b></span><span>avg <b></b></span><span>max <b></b></span><span>last <b>"), Co = /* @__PURE__ */ ut("<div class=counters-pick>"), Do = /* @__PURE__ */ ut("<div class=counters-chart><div class=counters-legend></div><canvas class=counters-main-canvas>"), Fo = /* @__PURE__ */ ut("<div class=counters><div class=counters-bar><button type=button class=counters-collapse></button><div class=counters-modes></div><span class=counters-count> shown</span></div><div class=counters-plot>"), No = /* @__PURE__ */ ut("<button type=button>"), Oo = /* @__PURE__ */ ut("<div class=counters-group><span class=counters-fam></span><div class=counters-chips>"), Po = /* @__PURE__ */ ut("<button type=button class=counters-chip>·"), Wo = /* @__PURE__ */ ut("<div class=counters-empty>"), Ho = /* @__PURE__ */ ut("<div class=counters-lane><div class=counters-lane-head><span class=counters-lane-label>·</span></div><canvas class=counters-lane-canvas>"), Uo = /* @__PURE__ */ ut("<button type=button class=counters-expand>"), zo = /* @__PURE__ */ ut("<div class=counters-leg><div class=counters-leg-top><span class=counters-leg-name>·");
const Gn = ["#4bb0c4", "#e6a13c", "#b06fc4", "#7fb36a", "#d1524e", "#5b8fd1", "#c98a5a", "#9aa84e"], Ae = 150, Go = 34, Vn = 6, le = (e, t) => e.key.endsWith("_pct") ? `${t.toFixed(1)}%` : e.key === "size" ? t >= 1e9 ? `${(t / 1e9).toFixed(2)} GB` : `${(t / 1e6).toFixed(1)} MB` : e.key === "dur" ? t >= 1e6 ? `${(t / 1e6).toFixed(1)} s` : `${(t / 1e3).toFixed(1)} ms` : Math.abs(t) >= 1e3 ? t.toLocaleString(void 0, {
  maximumFractionDigits: 0
}) : t.toFixed(2), Yn = (e, t) => e.max > e.min ? (t - e.min) / (e.max - e.min) : 0.5, ce = (e, t) => t - e * (t - 2) - 1;
function Vo(e) {
  const t = Cs(), n = () => e.gutter ?? 0, s = t.counterSeries(() => e.end > e.begin ? {
    begin: e.begin,
    end: e.end,
    width: 700
  } : null), [i, r] = gt(/* @__PURE__ */ new Set()), [o, a] = gt(null), [l, c] = gt("overlay"), [u, h] = gt(!1), [v, g] = gt(null), [p, m] = gt(/* @__PURE__ */ new Set()), [k, E] = gt("pid"), x = () => t.supportsSplit, y = (d) => m((M) => {
    const L = new Set(M);
    return L.has(d) ? L.delete(d) : L.add(d), L;
  });
  let R;
  de(() => {
    const d = s();
    if (!d || i().size > 0 || !d.series.length) return;
    const M = ["cpu/iowait_pct", "read/size", "loss/value"], L = d.series.filter((C) => M.includes(C.id)).map((C) => C.id);
    r(new Set(L.length ? L : d.series.slice(0, 3).map((C) => C.id)));
  });
  const T = Wt(() => (s()?.series ?? []).filter((d) => i().has(d.id))), f = (d) => Gn[T().findIndex((M) => M.id === d) % Gn.length], w = (d) => r((M) => {
    const L = new Set(M);
    return L.has(d) ? L.delete(d) : L.add(d), L;
  }), A = (d, M) => d.begin + (M + 0.5) * d.bucket_us, $ = (d, M) => {
    if (e.frac) return e.frac(A(d, M));
    const L = d.buckets * d.bucket_us;
    return L > 0 ? (A(d, M) - d.begin) / L : 0;
  };
  let I;
  const F = /* @__PURE__ */ new Map(), W = (d) => (M) => F.set(d, M), O = (d, M) => {
    const L = d.clientWidth || d.parentElement?.clientWidth || 0, C = window.devicePixelRatio || 1, Y = Math.max(1, Math.round(L * C)), X = Math.round(M * C);
    d.width !== Y && (d.width = Y), d.height !== X && (d.height = X), d.style.height !== `${M}px` && (d.style.height = `${M}px`);
    const K = d.getContext("2d");
    return K ? (K.setTransform(C, 0, 0, C, 0, 0), K.clearRect(0, 0, L, M), {
      ctx: K,
      W: L,
      H: M
    }) : null;
  }, N = (d, M) => {
    const L = d.buckets;
    if (L < 2 || M <= 0) return null;
    let C = 0;
    for (let B = L - 1; C < B; ) {
      const H = C + B >> 1;
      $(d, H) * M < -Vn ? C = H + 1 : B = H;
    }
    let Y = L - 1;
    for (let B = 0; B < Y; ) {
      const H = B + Y + 1 >> 1;
      $(d, H) * M > M + Vn ? Y = H - 1 : B = H;
    }
    const X = Math.max(0, C - 1), K = Math.min(L - 1, Y + 1);
    if (K <= X) return null;
    const V = new Float64Array(K - X + 1);
    for (let B = 0; B < V.length; B++) V[B] = $(d, X + B) * M;
    return {
      lo: X,
      xs: V
    };
  }, S = (d, M, L, C, Y, X) => {
    const {
      lo: K,
      xs: V
    } = L;
    if (X) {
      d.beginPath(), d.moveTo(V[0], C);
      for (let B = 0; B < V.length; B++) d.lineTo(V[B], ce(Yn(M, M.values[K + B]), C));
      d.lineTo(V[V.length - 1], C), d.closePath(), d.globalAlpha = 0.18, d.fillStyle = Y, d.fill(), d.globalAlpha = 1;
    }
    d.beginPath();
    for (let B = 0; B < V.length; B++) {
      const H = V[B], Z = ce(Yn(M, M.values[K + B]), C);
      B === 0 ? d.moveTo(H, Z) : d.lineTo(H, Z);
    }
    d.strokeStyle = Y, d.lineWidth = X ? 1.25 : 1.5, d.stroke();
  }, P = (d, M, L, C, Y) => {
    const X = M.buckets, {
      lo: K,
      xs: V
    } = C;
    let B = 1e-9;
    for (let Z = 0; Z < X; Z++) {
      let et = 0;
      for (const z of L) et += Math.max(0, z.values[Z] || 0);
      et > B && (B = et);
    }
    const H = new Float64Array(V.length);
    for (const Z of L) {
      const et = f(Z.id);
      d.beginPath();
      for (let z = 0; z < V.length; z++) d.lineTo(V[z], ce(H[z] / B, Ae));
      for (let z = V.length - 1; z >= 0; z--)
        H[z] += Math.max(0, Z.values[K + z] || 0), d.lineTo(V[z], ce(H[z] / B, Ae));
      d.closePath(), d.globalAlpha = 0.55, d.fillStyle = et, d.fill(), d.globalAlpha = 1, d.beginPath();
      for (let z = 0; z < V.length; z++) {
        const xt = ce(H[z] / B, Ae);
        z === 0 ? d.moveTo(V[z], xt) : d.lineTo(V[z], xt);
      }
      d.strokeStyle = et, d.lineWidth = 1, d.stroke();
    }
  }, it = (d, M, L) => {
    const C = o();
    if (C == null) return;
    const Y = Math.round(C * M) + 0.5;
    d.save(), d.strokeStyle = "rgba(150,150,150,0.7)", d.lineWidth = 1, d.setLineDash([2, 2]), d.beginPath(), d.moveTo(Y, 0), d.lineTo(Y, L), d.stroke(), d.restore();
  }, rt = (d, M, L) => {
    const C = v();
    if (!C) return;
    const Y = Math.min(C.a, C.b) * M, X = Math.max(C.a, C.b) * M;
    d.save(), d.fillStyle = "rgba(230,161,60,0.14)", d.fillRect(Y, 0, X - Y, L), d.strokeStyle = "rgba(230,161,60,0.6)", d.lineWidth = 1, d.strokeRect(Y + 0.5, 0.5, X - Y - 1, L - 1), d.restore();
  }, ft = () => {
    const d = s(), M = T();
    if (!d || M.length === 0) return;
    if (l() === "split") {
      for (const X of M) {
        const K = F.get(X.id);
        if (!K) continue;
        const V = O(K, Go);
        if (!V) continue;
        const B = N(d, V.W);
        B && S(V.ctx, X, B, V.H, f(X.id), !0), rt(V.ctx, V.W, V.H), it(V.ctx, V.W, V.H);
      }
      return;
    }
    const L = I;
    if (!L) return;
    const C = O(L, Ae);
    if (!C) return;
    const Y = N(d, C.W);
    if (Y)
      if (l() === "stacked") P(C.ctx, d, M, Y, C.W);
      else for (const X of M) S(C.ctx, X, Y, C.H, f(X.id), !1);
    rt(C.ctx, C.W, C.H), it(C.ctx, C.W, C.H);
  };
  de(() => {
    e.tick?.(), l(), T(), s(), o(), v(), ft();
  }), sn(() => {
    if (!R) return;
    const d = new ResizeObserver(() => ft());
    d.observe(R), pe(() => d.disconnect());
  });
  const mt = (d) => {
    if (!R) return null;
    const L = (R.querySelector("canvas") ?? R).getBoundingClientRect();
    return L.width <= 0 ? null : Math.max(0, Math.min(1, (d - L.left) / L.width));
  }, Bt = (d) => {
    if (v()) return;
    const M = mt(d.clientX);
    M != null && a(M);
  }, vt = 6e-3, wt = (d) => {
    const M = mt(d.clientX);
    M != null && g((L) => L ? {
      a: L.a,
      b: M
    } : null);
  }, Tt = (d) => {
    window.removeEventListener("mousemove", wt), window.removeEventListener("mouseup", Tt);
    const M = v();
    if (g(null), !M) return;
    const L = mt(d.clientX) ?? M.b, C = Math.min(M.a, L), Y = Math.max(M.a, L);
    if (Y - C < vt || !e.realAtFrac) return;
    const X = e.realAtFrac(C), K = e.realAtFrac(Y);
    K > X && e.onZoomRange?.(X, K);
  }, U = (d) => {
    if (d.button !== 0) return;
    const M = mt(d.clientX);
    M != null && (d.preventDefault(), a(null), g({
      a: M,
      b: M
    }), window.addEventListener("mousemove", wt), window.addEventListener("mouseup", Tt));
  };
  pe(() => {
    window.removeEventListener("mousemove", wt), window.removeEventListener("mouseup", Tt);
  });
  const tt = (d, M) => {
    const L = s();
    if (!L) return 0;
    const C = e.realAtFrac ? e.realAtFrac(M) : L.begin + M * L.buckets * L.bucket_us, Y = Math.round((C - L.begin) / L.bucket_us - 0.5);
    return d.values[Math.max(0, Math.min(d.values.length - 1, Y))] ?? 0;
  }, q = (d) => nt(Rt, {
    get when() {
      return o() != null;
    },
    get fallback() {
      return (() => {
        var M = Eo(), L = M.firstChild, C = L.firstChild, Y = C.nextSibling, X = L.nextSibling, K = X.firstChild, V = K.nextSibling, B = X.nextSibling, H = B.firstChild, Z = H.nextSibling, et = B.nextSibling, z = et.firstChild, xt = z.nextSibling;
        return G(Y, () => le(d.s, d.s.min)), G(V, () => le(d.s, d.s.mean)), G(Z, () => le(d.s, d.s.max)), G(xt, () => le(d.s, d.s.last)), M;
      })();
    },
    get children() {
      var M = Io(), L = M.firstChild;
      return G(L, () => le(d.s, tt(d.s, o()))), M;
    }
  }), dt = () => {
    var M;
    const d = {};
    for (const L of s()?.series ?? []) (d[M = L.family] ?? (d[M] = [])).push(L);
    return Object.entries(d);
  }, Mt = ["overlay", "split", "stacked"];
  return nt(Rt, {
    get when() {
      return (s()?.series.length ?? 0) > 0;
    },
    get children() {
      var d = Fo(), M = d.firstChild, L = M.firstChild, C = L.nextSibling, Y = C.nextSibling, X = Y.firstChild, K = M.nextSibling;
      L.$$click = () => h((B) => !B), G(C, nt(Kt, {
        each: Mt,
        children: (B) => (() => {
          var H = No();
          return H.$$click = () => c(B), G(H, B), yt(() => H.classList.toggle("on", l() === B)), H;
        })()
      })), G(Y, () => T().length, X), G(d, nt(Rt, {
        get when() {
          return !u();
        },
        get children() {
          var B = Co();
          return G(B, nt(Kt, {
            get each() {
              return dt();
            },
            children: ([H, Z]) => (() => {
              var et = Oo(), z = et.firstChild, xt = z.nextSibling;
              return G(z, H), G(xt, nt(Kt, {
                each: Z,
                children: ($t) => (() => {
                  var ht = Po(), Yt = ht.firstChild;
                  return ht.$$click = () => w($t.id), G(ht, () => $t.name, Yt), G(ht, () => $t.key, null), yt(() => ht.classList.toggle("on", !!i().has($t.id))), ht;
                })()
              })), et;
            })()
          })), B;
        }
      }), K), K.$$dblclick = () => e.onResetView?.(), K.$$mousedown = U, K.addEventListener("mouseleave", () => a(null)), K.$$mousemove = Bt;
      var V = R;
      return typeof V == "function" ? te(V, K) : R = K, G(K, nt(Rt, {
        get when() {
          return T().length;
        },
        get fallback() {
          return (() => {
            var B = Wo();
            return G(B, () => i().size > 0 ? "no data for the selected counters in this window" : "pick counters to overlay"), B;
          })();
        },
        get children() {
          return [nt(Rt, {
            get when() {
              return l() === "split";
            },
            get children() {
              return nt(Kt, {
                get each() {
                  return T();
                },
                children: (B) => (() => {
                  var H = Ho(), Z = H.firstChild, et = Z.firstChild, z = et.firstChild, xt = Z.nextSibling;
                  G(et, () => B.name, z), G(et, () => B.key, null), G(Z, nt(q, {
                    s: B
                  }), null);
                  var $t = W(B.id);
                  return typeof $t == "function" && te($t, xt), yt((ht) => {
                    var Yt = `0 0 ${n()}px`, Ct = f(B.id);
                    return Yt !== ht.e && Pt(Z, "flex", ht.e = Yt), Ct !== ht.t && Pt(et, "color", ht.t = Ct), ht;
                  }, {
                    e: void 0,
                    t: void 0
                  }), H;
                })()
              });
            }
          }), nt(Rt, {
            get when() {
              return l() !== "split";
            },
            get children() {
              var B = Do(), H = B.firstChild, Z = H.nextSibling;
              G(H, nt(Kt, {
                get each() {
                  return T();
                },
                children: (z) => (() => {
                  var xt = zo(), $t = xt.firstChild, ht = $t.firstChild, Yt = ht.firstChild;
                  return G($t, nt(Rt, {
                    get when() {
                      return x();
                    },
                    get children() {
                      var Ct = Uo();
                      return Ct.$$click = () => y(z.id), G(Ct, () => p().has(z.id) ? "-" : "+"), yt((ie) => {
                        var mn = !!p().has(z.id), vn = p().has(z.id) ? "hide split" : "split by pid/node";
                        return mn !== ie.e && Ct.classList.toggle("on", ie.e = mn), vn !== ie.t && Ie(Ct, "title", ie.t = vn), ie;
                      }, {
                        e: void 0,
                        t: void 0
                      }), Ct;
                    }
                  }), ht), G(ht, () => z.name, Yt), G(ht, () => z.key, null), G(xt, nt(q, {
                    s: z
                  }), null), yt((Ct) => Pt(ht, "color", f(z.id))), xt;
                })()
              }));
              var et = I;
              return typeof et == "function" ? te(et, Z) : I = Z, yt((z) => Pt(H, "flex", `0 0 ${n()}px`)), B;
            }
          })];
        }
      })), G(d, nt(Rt, {
        get when() {
          return x();
        },
        get children() {
          return nt(Kt, {
            get each() {
              return T().filter((B) => p().has(B.id));
            },
            children: (B) => nt(_o, {
              get seriesId() {
                return B.id;
              },
              get name() {
                return B.name;
              },
              get key_() {
                return B.key;
              },
              get color() {
                return f(B.id);
              },
              get dim() {
                return k();
              },
              get begin() {
                return e.begin;
              },
              get end() {
                return e.end;
              },
              get gutter() {
                return n();
              },
              frac: (H) => e.frac?.(H) ?? 0,
              realAtFrac: (H) => e.realAtFrac?.(H) ?? 0,
              tick: () => e.tick?.() ?? 0,
              onClose: () => y(B.id),
              onDim: E,
              get docked() {
                return e.dockedLane?.() === B.id;
              },
              get onDock() {
                return e.onDockLane ? () => e.onDockLane(B.id, f(B.id)) : void 0;
              }
            })
          });
        }
      }), null), yt((B) => {
        var H = !u(), Z = u() ? "show counter list" : "hide counter list", et = !!e.onZoomRange;
        return H !== B.e && L.classList.toggle("open", B.e = H), Z !== B.t && Ie(L, "title", B.t = Z), et !== B.a && K.classList.toggle("selectable", B.a = et), B;
      }, {
        e: void 0,
        t: void 0,
        a: void 0
      }), d;
    }
  });
}
es(["click", "mousemove", "mousedown", "dblclick"]);
const Yo = '.counters{--bg: #0a0b0a;--panel-2: #0a0b0a;--elev: #12140f;--hair: #16180f;--border: #262920;--line: #1f2119;--text-hi: #e6e2ce;--muted: #8a927c;--dim: #5f6a53;--accent: #e6a13c;--accent-ink: #0a0b0a;--mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace}', Xo = '.counters{flex:0 0 auto;display:flex;flex-direction:column;border-bottom:1px solid var(--hair);background:var(--panel-2, var(--bg));font-family:var(--mono)}.counters-bar{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:4px 10px;border-bottom:1px solid var(--line)}.counters-count{font-size:10px;color:var(--dim)}.counters-pick{display:flex;flex-direction:column;gap:4px;padding:5px 10px;border-bottom:1px solid var(--line);max-height:96px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--border) transparent}.counters-pick::-webkit-scrollbar,.counters-chips::-webkit-scrollbar{width:6px;height:6px}.counters-pick::-webkit-scrollbar-thumb,.counters-chips::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}.counters-pick::-webkit-scrollbar-track,.counters-chips::-webkit-scrollbar-track{background:transparent}.counters-group{display:flex;align-items:center;gap:6px;min-width:0}.counters-chips{display:flex;gap:5px;overflow-x:auto;flex:1 1 auto;min-width:0;padding-bottom:1px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}.counters-fam{flex:0 0 64px;font-size:10px;letter-spacing:.5px;text-transform:uppercase;color:var(--dim)}.counters-chip{font:inherit;font-family:var(--mono);font-size:10px;padding:2px 7px;color:var(--muted);background:var(--elev);border:1px solid var(--line);border-radius:9px;cursor:pointer;white-space:nowrap}.counters-chip:hover{color:var(--text-hi);border-color:var(--border)}.counters-chip.on{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}.counters-modes{display:flex;gap:0;margin-right:4px}.counters-modes button{font:inherit;font-family:var(--mono);font-size:10px;padding:2px 8px;color:var(--muted);background:var(--elev);border:1px solid var(--line);cursor:pointer}.counters-modes button:first-child{border-radius:3px 0 0 3px}.counters-modes button:last-child{border-radius:0 3px 3px 0;border-left:none}.counters-modes button.on{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}.counters-collapse{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;padding:0;background:none;border:none;cursor:pointer;color:var(--muted)}.counters-collapse:before{content:"";border-left:4px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .1s}.counters-collapse.open:before{transform:rotate(90deg)}.counters-collapse:hover{color:var(--text-hi)}.counters-plot{position:relative;padding:4px 0 2px}.counters-plot.selectable{cursor:crosshair}.counters-chart{position:relative;display:flex;align-items:stretch}.counters-lane{display:flex;align-items:center;gap:0;padding:1px 0}.counters-lane-head{display:flex;align-items:baseline;justify-content:flex-end;gap:10px;padding-right:10px;overflow:hidden;min-width:0}.counters-lane-label{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.counters-lane-canvas{flex:1 1 0;min-width:0;height:34px;display:block}.counters-main-canvas{display:block;flex:1 1 auto;min-width:0;height:150px}.cstat{display:inline-flex;gap:9px;font-size:10px;color:var(--dim);white-space:nowrap}.cstat b{color:var(--text-hi);font-weight:600}.counters-empty{padding:20px;text-align:center;color:var(--dim);font-size:12px}.counters-legend{display:flex;flex-direction:column;align-items:flex-end;gap:5px;padding:4px 10px 4px 0;overflow:hidden;min-width:0;font-size:11px}.counters-leg{display:flex;flex-direction:column;align-items:flex-end;gap:1px;max-width:100%;overflow:hidden}.counters-leg-name{font-weight:600;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.counters-leg-top{display:flex;align-items:center;gap:4px;max-width:100%}.counters-expand{flex:0 0 auto;width:13px;height:13px;padding:0;font:inherit;font-family:var(--mono);font-size:11px;line-height:11px;color:var(--muted);background:var(--elev);border:1px solid var(--line);border-radius:3px;cursor:pointer}.counters-expand:hover{color:var(--text-hi);border-color:var(--border)}.counters-expand.on{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}.cheat{border-top:1px solid var(--line)}.cheat-bar{display:flex;align-items:center;gap:12px;padding:3px 10px;font-size:10px;color:var(--dim)}.cheat-title{font-weight:600}.cheat-dims{display:flex;gap:0}.cheat-dims button{font:inherit;font-family:var(--mono);font-size:10px;padding:1px 7px;color:var(--muted);background:var(--elev);border:1px solid var(--line);cursor:pointer}.cheat-dims button:first-child{border-radius:3px 0 0 3px}.cheat-dims button:last-child{border-radius:0 3px 3px 0;border-left:none}.cheat-dims button.on{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}.cheat-read{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cheat-read b{color:var(--text-hi);font-weight:600}.cheat-close{flex:0 0 auto;padding:0 6px;font:inherit;font-family:var(--mono);color:var(--muted);background:none;border:none;cursor:pointer}.cheat-close:hover{color:var(--text-hi)}.cheat-plot{display:flex;align-items:stretch}.cheat-labels{display:flex;flex-direction:column;align-items:flex-end;overflow:hidden;padding-right:8px}.cheat-label{display:flex;align-items:center;font-size:9px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.cheat-canvas{flex:1 1 auto;min-width:0;display:block}.cheat-dock{flex:0 0 auto;font:inherit;font-family:var(--mono);font-size:10px;padding:1px 7px;color:var(--muted);background:var(--elev);border:1px solid var(--line);border-radius:3px;cursor:pointer}.cheat-dock:hover{color:var(--text-hi);border-color:var(--border)}.cheat-dock.on{color:var(--accent-ink);background:var(--accent);border-color:var(--accent)}.cheat-canvas.clickable{cursor:pointer}.cheat-label.pinned{color:var(--text-hi);font-weight:600}.cheat-band-label{display:flex;align-items:center;height:100%;font-size:9px;color:var(--dim);white-space:nowrap}';
var Ko = /* @__PURE__ */ ut('<div style=width:100%;height:460px;background:#0a0b0a;display:flex;flex-direction:column><canvas style="width:100%;flex:1 1 auto;display:block">');
const Xn = "dfd-counter-widget-css";
function jo(e) {
  const t = e.getRootNode();
  if (t.querySelector(`#${Xn}`)) return;
  const n = document.createElement("style");
  n.id = Xn, n.textContent = `${Yo}
${Xo}`, t.appendChild(n);
}
function he(e) {
  return e ? e instanceof Uint8Array ? e : e instanceof DataView ? new Uint8Array(e.buffer, e.byteOffset, e.byteLength) : e instanceof ArrayBuffer ? new Uint8Array(e) : new Uint8Array(0) : new Uint8Array(0);
}
function qo(e) {
  const t = e.model;
  let n, s;
  const [i, r] = gt(null), o = {
    supportsSplit: !1,
    counterSeries: () => i,
    counterSplit: () => () => null,
    nodeCounters: () => () => null
  }, [a, l] = gt(0), [c, u] = gt(t.get("begin")), [h, v] = gt(t.get("end") || t.get("span"));
  return sn(() => {
    jo(n);
    let g = 0;
    const p = new wo(n, {
      onRangeChange: (f, w) => {
        u(f), v(w), t.set("begin", f), t.set("end", w), t.set("width", p.viewportWidth()), t.set("req", ++g), t.save_changes();
      },
      // Ticks each animated frame so the counter overlay re-lays its canvas in
      // lockstep with the tracks (smooth pan/zoom, timelapse-aware).
      onFrame: () => l((f) => f + 1 & 65535)
    });
    s = p, p.setTheme("dark");
    const m = () => {
      const f = t.get("span");
      f > 0 && p.setTotalSpan(f);
    }, k = () => {
      const {
        events: f,
        density: w
      } = Tn(re(he(t.get("timeline_ipc"))));
      p.setData(f, w);
    }, E = () => {
      const {
        read: f,
        write: w
      } = ro(re(he(t.get("counters_ipc"))));
      if (!f.length) return;
      const A = t.get("begin"), $ = (t.get("end") - A) / f.length;
      p.setCounters(A, $, f, w);
    }, x = () => {
      const {
        density: f
      } = Tn(re(he(t.get("overview_ipc"))));
      f.length && p.setOverview(f);
    }, y = () => {
      const f = (t.get("breaks_gaps") || []).map((w) => ({
        begin: w[0],
        end: w[1]
      }));
      p.setBreaks(f, !!t.get("multi_run"));
    }, R = () => {
      const f = io(re(he(t.get("proctree_ipc"))));
      if (!f.length) return;
      p.setProcTree(f);
      const w = /* @__PURE__ */ new Map(), A = /* @__PURE__ */ new Map(), $ = /* @__PURE__ */ new Map(), I = /* @__PURE__ */ new Map();
      for (const F of f) {
        F.host && w.set(F.pid, F.host), F.bytes && A.set(F.pid, F.bytes), F.io_busy && $.set(F.pid, F.io_busy);
        const W = F.rank != null && F.rank !== "";
        I.set(String(F.pid), W ? `rank ${F.rank}` : `proc ${F.pid}`);
      }
      p.setHosts(w), p.setBytes(A), p.setIoBusy($), p.setProcessLabels(I);
    }, T = () => {
      const f = re(he(t.get("series_ipc")));
      if (!f.length) {
        r(null);
        return;
      }
      try {
        r(JSON.parse(new TextDecoder().decode(f)));
      } catch {
        r(null);
      }
    };
    m(), x(), R(), y(), k(), E(), T(), t.on("change:span", m), t.on("change:overview_ipc", x), t.on("change:breaks_gaps", y), t.on("change:timeline_ipc", k), t.on("change:counters_ipc", E), t.on("change:series_ipc", T), t.on("change:proctree_ipc", R), pe(() => {
      t.off("change:span", m), t.off("change:overview_ipc", x), t.off("change:breaks_gaps", y), t.off("change:timeline_ipc", k), t.off("change:counters_ipc", E), t.off("change:series_ipc", T), t.off("change:proctree_ipc", R), p.destroy();
    });
  }), (() => {
    var g = Ko(), p = g.firstChild;
    G(g, nt(Es.Provider, {
      value: o,
      get children() {
        return nt(Vo, {
          get begin() {
            return c();
          },
          get end() {
            return h();
          },
          gutter: D,
          tick: a,
          frac: (k) => s?.frac(k) ?? 0,
          realAtFrac: (k) => s?.realAtFrac(k) ?? 0,
          onZoomRange: (k, E) => s?.focusRealRange(k, E),
          onResetView: () => s?.resetView()
        });
      }
    }), p);
    var m = n;
    return typeof m == "function" ? te(m, p) : n = p, g;
  })();
}
const Qo = {
  render({
    model: e,
    el: t
  }) {
    const n = Js(() => nt(qo, {
      model: e
    }), t);
    return () => n();
  }
};
export {
  Qo as default
};
