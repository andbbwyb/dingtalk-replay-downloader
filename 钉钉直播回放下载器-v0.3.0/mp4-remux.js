/*!
 * mp4-remux.js — 把 mux.js 生成的分片 MP4(fMP4) 重封装为标准的渐进式 MP4。
 *
 * 背景：mux.js 的 Transmuxer 在第一次 flush 时就写出 init segment，此时总时长未知，
 * 于是把 mvhd / tkhd / mdhd 的 duration 一律写成 0xFFFFFFFF（规范里的"未知"哨兵）。
 * 同时它不生成 mehd，也不生成样本表（stts/stsc/stsz/stco 全为空），媒体数据只活在
 * moof/trun 里。结果：只认 moov 的播放器（资源管理器、WMP、手机相册…）读不到时长，
 * 退回去算 0xFFFFFFFF/timescale，显示成十几小时，而且没有索引无法拖动进度条。
 *
 * 这个模块把 fMP4 读一遍，从 tfdt + trun 还原真实的逐样本时长/大小/关键帧信息，
 * 重建成一个普通 MP4：真实的 moov 样本表 + 正确时长 + 带索引 + 可由任意播放器处理。
 * 只搬运字节，不重新编码，画质无损。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Mp4Remux = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var U32_MAX = 4294967295;
  var MAC_EPOCH_OFFSET = 2082844800; // 1904-01-01 -> 1970-01-01 的秒数

  function rdU32(b, o) {
    return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  }
  function rdI32(b, o) {
    return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  }
  function rdU64(b, o) {
    return rdU32(b, o) * 4294967296 + rdU32(b, o + 4);
  }
  function type4(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  }
  function wrU32(a, o, v) {
    a[o] = (v >>> 24) & 0xff;
    a[o + 1] = (v >>> 16) & 0xff;
    a[o + 2] = (v >>> 8) & 0xff;
    a[o + 3] = v & 0xff;
  }
  function wrU64(a, o, v) {
    wrU32(a, o, Math.floor(v / 4294967296));
    wrU32(a, o + 4, v % 4294967296);
  }

  function walkBoxes(buf, start, end, fn) {
    var p = start;
    while (p + 8 <= end) {
      var size = rdU32(buf, p);
      var hdr = 8;
      if (size === 1) {
        if (p + 16 > end) return;
        size = rdU64(buf, p + 8);
        hdr = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < hdr || p + size > end) return;
      if (fn(type4(buf, p + 4), p, size, hdr) === false) return;
      p += size;
    }
  }

  function makeBox(type, parts) {
    var total = 8;
    var i;
    for (i = 0; i < parts.length; i += 1) total += parts[i].length;
    var out = new Uint8Array(total);
    wrU32(out, 0, total);
    for (i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    var o = 8;
    for (i = 0; i < parts.length; i += 1) {
      out.set(parts[i], o);
      o += parts[i].length;
    }
    return out;
  }

  function fullBox(type, version, flags, parts) {
    var head = new Uint8Array(4);
    head[0] = version;
    head[1] = (flags >>> 16) & 0xff;
    head[2] = (flags >>> 8) & 0xff;
    head[3] = flags & 0xff;
    return makeBox(type, [head].concat(parts));
  }

  function u32Array(values) {
    var out = new Uint8Array(values.length * 4);
    for (var i = 0; i < values.length; i += 1) wrU32(out, i * 4, values[i]);
    return out;
  }

  /* ---------------- 解析 ---------------- */

  function parseTrak(buf, start, size) {
    var track = {
      trackId: 0,
      handler: "",
      tkhd: null,
      mdhd: null,
      hdlr: null,
      stsd: null,
      minfParts: []
    };
    walkBoxes(buf, start + 8, start + size, function (type, pos, sz, hdr) {
      if (type === "tkhd") {
        track.tkhd = buf.slice(pos, pos + sz);
        track.trackId = buf[pos + 8] === 1 ? rdU32(buf, pos + 28) : rdU32(buf, pos + 20);
        return;
      }
      if (type !== "mdia") return;
      walkBoxes(buf, pos + hdr, pos + sz, function (t2, p2, s2, h2) {
        if (t2 === "mdhd") {
          track.mdhd = buf.slice(p2, p2 + s2);
          return;
        }
        if (t2 === "hdlr") {
          track.hdlr = buf.slice(p2, p2 + s2);
          track.handler = type4(buf, p2 + 16);
          return;
        }
        if (t2 !== "minf") return;
        walkBoxes(buf, p2 + h2, p2 + s2, function (t3, p3, s3, h3) {
          if (t3 === "stbl") {
            walkBoxes(buf, p3 + h3, p3 + s3, function (t4, p4, s4) {
              if (t4 === "stsd") track.stsd = buf.slice(p4, p4 + s4);
            });
            return;
          }
          track.minfParts.push(buf.slice(p3, p3 + s3));
        });
      });
    });
    return track;
  }

  function parseTfhd(buf, pos, size, hdr) {
    var flags = rdU32(buf, pos + hdr) & 0xffffff;
    var o = pos + hdr + 4;
    var r = {
      trackId: rdU32(buf, o),
      baseDataOffset: null,
      defaultBaseIsMoof: false,
      defaultDuration: 0,
      defaultSize: 0,
      defaultFlags: 0,
      present: flags
    };
    o += 4;
    if (flags & 0x01) { r.baseDataOffset = rdU64(buf, o); o += 8; }
    if (flags & 0x02) { o += 4; }
    if (flags & 0x08) { r.defaultDuration = rdU32(buf, o); o += 4; }
    if (flags & 0x10) { r.defaultSize = rdU32(buf, o); o += 4; }
    if (flags & 0x20) { r.defaultFlags = rdU32(buf, o); o += 4; }
    if (flags & 0x20000) r.defaultBaseIsMoof = true;
    return r;
  }

  // 极少数损坏文件会缺 mvhd，这里按 v0 规范合成一个
  function makeMvhd(timescale, duration) {
    var out = new Uint8Array(108);
    wrU32(out, 0, 108);
    out[4] = 0x6d; out[5] = 0x76; out[6] = 0x68; out[7] = 0x64; // mvhd
    wrU32(out, 20, timescale);
    wrU32(out, 24, duration);
    wrU32(out, 28, 0x00010000); // rate 1.0
    out[32] = 0x01; out[33] = 0x00; // volume 1.0
    var matrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
    for (var i = 0; i < 9; i += 1) wrU32(out, 44 + i * 4, matrix[i]);
    wrU32(out, 104, 0xffffffff); // next_track_ID
    return out;
  }

  // stco / co64 里记录的是"文件绝对偏移"，所以 moov 拼好、位置确定后要整体平移一次。
  function shiftChunkOffsets(moov, base) {
    if (!base) return;
    function visit(start, end) {
      walkBoxes(moov, start, end, function (type, pos, size, hdr) {
        if (type === "stco") {
          var n = rdU32(moov, pos + hdr + 4);
          for (var i = 0; i < n; i += 1) {
            var o = pos + hdr + 8 + i * 4;
            wrU32(moov, o, (rdU32(moov, o) + base) >>> 0);
          }
          return;
        }
        if (type === "co64") {
          var m = rdU32(moov, pos + hdr + 4);
          for (var j = 0; j < m; j += 1) {
            var q = pos + hdr + 8 + j * 8;
            wrU64(moov, q, rdU64(moov, q) + base);
          }
          return;
        }
        if (type === "trak" || type === "mdia" || type === "minf" || type === "stbl") {
          visit(pos + hdr, pos + size);
        }
      });
    }
    visit(8, moov.length);
  }

  /* ---------------- 主流程 ---------------- */

  function remuxDetailed(input) {
    var buf = input;
    var len = buf.length;

    // 1) 顶层盒子
    var ftyp = null;
    var moovPos = -1;
    var moovSize = 0;
    var fragments = [];
    var lastFragment = null;

    var p = 0;
    while (p + 8 <= len) {
      var size = rdU32(buf, p);
      var type = type4(buf, p + 4);
      var hdr = 8;
      if (size === 1) {
        size = rdU64(buf, p + 8);
        hdr = 16;
      } else if (size === 0) {
        size = len - p;
      }
      if (size < hdr || p + size > len) break;
      if (type === "ftyp") ftyp = buf.slice(p, p + size);
      else if (type === "moov") { moovPos = p; moovSize = size; }
      else if (type === "moof") {
        lastFragment = { moofStart: p, moofEnd: p + size, mdatStart: -1, mdatEnd: -1, mdatHdr: 8 };
        fragments.push(lastFragment);
      } else if (type === "mdat" && lastFragment && lastFragment.mdatStart < 0) {
        lastFragment.mdatStart = p;
        lastFragment.mdatEnd = p + size;
        lastFragment.mdatHdr = hdr;
      }
      p += size;
    }

    if (moovPos < 0) throw new Error("MP4 中没有找到 moov。");
    // 已经是普通 MP4，原样返回
    if (!fragments.length) return { data: buf, stats: { remuxed: false } };

    var good = [];
    for (var i = 0; i < fragments.length; i += 1) {
      if (fragments[i].mdatStart >= 0) good.push(fragments[i]);
    }
    if (!good.length) throw new Error("分片 MP4 中没有找到 mdat。");

    // 2) moov 里的轨道信息
    var mvhdBytes = null;
    var movieTimescale = 1000;
    var tracksByBox = [];
    var trexDefaults = {};

    walkBoxes(buf, moovPos + 8, moovPos + moovSize, function (type, pos, sz, hdr) {
      if (type === "mvex") {
        walkBoxes(buf, pos + hdr, pos + sz, function (t2, p2, s2, h2) {
          if (t2 !== "trex") return;
          var id = rdU32(buf, p2 + h2 + 4);
          trexDefaults[id] = {
            duration: rdU32(buf, p2 + h2 + 12),
            size: rdU32(buf, p2 + h2 + 16),
            flags: rdU32(buf, p2 + h2 + 20)
          };
        });
        return;
      }
      if (type === "mvhd") {
        mvhdBytes = buf.slice(pos, pos + sz);
        var v = buf[pos + 8];
        movieTimescale = v === 1 ? rdU32(buf, pos + 28) : rdU32(buf, pos + 20);
      } else if (type === "trak") {
        var t = parseTrak(buf, pos, sz);
        if (!t.tkhd || !t.mdhd || !t.stsd) return; // 缺关键盒子的轨道无法重建
        var mdTimescale = 0;
        if (t.mdhd) mdTimescale = t.mdhd[8] === 1 ? rdU32(t.mdhd, 28) : rdU32(t.mdhd, 20);
        t.timescale = mdTimescale || 90000;
        t.durs = [];
        t.sizes = [];
        t.ctos = [];
        t.syncs = [];
        t.chunks = [];
        t.firstDts = null;
        tracksByBox.push(t);
      }
    });

    var trackById = {};
    for (i = 0; i < tracksByBox.length; i += 1) trackById[tracksByBox[i].trackId] = tracksByBox[i];

    // 3) 遍历所有分片，收集逐样本信息
    for (var fi = 0; fi < good.length; fi += 1) {
      var frag = good[fi];
      // 该分片 mdat 净负载的绝对起点（旧）
      frag.oldPayloadStart = frag.mdatStart + frag.mdatHdr;

      (function (frag, fi) {
        var moof = frag.moofStart;
        walkBoxes(buf, moof + 8, frag.moofEnd, function (type, trafPos, trafSize, trafHdr) {
          if (type !== "traf") return;

          var tfhd = null;
          var tfdt = 0;
          var truns = [];

          walkBoxes(buf, trafPos + trafHdr, trafPos + trafSize, function (t2, p2, s2, h2) {
            if (t2 === "tfhd") tfhd = parseTfhd(buf, p2, s2, h2);
            else if (t2 === "tfdt") {
              tfdt = buf[p2 + 8] === 1 ? rdU64(buf, p2 + 12) : rdU32(buf, p2 + 12);
            } else if (t2 === "trun") {
              truns.push({ pos: p2, size: s2, hdr: h2 });
            }
          });

          if (!tfhd) return;
          var track = trackById[tfhd.trackId];
          if (!track) return;

          // tfhd 没写的缺省值要回落到 trex 里声明的值（mux.js 不依赖这条路径，但规范如此）
          var trex = trexDefaults[tfhd.trackId];
          if (trex) {
            if (!(tfhd.present & 0x08)) tfhd.defaultDuration = trex.duration;
            if (!(tfhd.present & 0x10)) tfhd.defaultSize = trex.size;
            if (!(tfhd.present & 0x20)) tfhd.defaultFlags = trex.flags;
          }

          if (track.firstDts == null) track.firstDts = tfdt;

          var base = tfhd.baseDataOffset;
          if (base == null) base = moof; // 规范：缺省基准是所在 moof 的首字节

          var cursor = null;
          var dts = tfdt;

          for (var ti = 0; ti < truns.length; ti += 1) {
            var tr = truns[ti];
            var flags = rdU32(buf, tr.pos + tr.hdr) & 0xffffff;
            var version = buf[tr.pos + tr.hdr];
            var o = tr.pos + tr.hdr + 4;
            var count = rdU32(buf, o);
            o += 4;

            var dataOffset = null;
            if (flags & 0x01) { dataOffset = rdI32(buf, o); o += 4; }
            var firstSampleFlags = null;
            if (flags & 0x04) { firstSampleFlags = rdU32(buf, o); o += 4; }

            if (dataOffset != null) cursor = base + dataOffset;
            else if (cursor == null) cursor = base;

            var chunk = { count: count, oldOffset: cursor, frag: frag };
            track.chunks.push(chunk);

            for (var si = 0; si < count; si += 1) {
              var dur = tfhd.defaultDuration;
              var sz = tfhd.defaultSize;
              var fl = (si === 0 && firstSampleFlags != null) ? firstSampleFlags : tfhd.defaultFlags;
              var cto = 0;

              if (flags & 0x100) { dur = rdU32(buf, o); o += 4; }
              if (flags & 0x200) { sz = rdU32(buf, o); o += 4; }
              if (flags & 0x400) { fl = rdU32(buf, o); o += 4; }
              if (flags & 0x800) { cto = version === 1 ? rdI32(buf, o) : rdU32(buf, o); o += 4; }

              track.durs.push(dur);
              track.sizes.push(sz);
              track.ctos.push(cto);
              track.syncs.push((fl & 0x10000) ? 0 : 1);

              cursor += sz;
              dts += dur;
            }
          }
        });
      })(frag, fi);
    }

    // 4) 计算输出 mdat 布局（保持原有分片顺序，只丢掉 moof）
    var newPayloadStart = 0;
    for (i = 0; i < good.length; i += 1) {
      good[i].newPayloadStart = newPayloadStart;
      newPayloadStart += good[i].mdatEnd - good[i].oldPayloadStart;
    }

    // 5) 重建每个轨道的样本表
    var maxDurationMs = 0;

    // 各轨道的起始时间不同时（罕见但合法），用 edit list 保留相对偏移，避免音画不同步
    var minStartSec = Infinity;
    for (i = 0; i < tracksByBox.length; i += 1) {
      var probe = tracksByBox[i];
      if (probe.sizes.length && probe.firstDts != null) {
        var sec = probe.firstDts / probe.timescale;
        if (sec < minStartSec) minStartSec = sec;
      }
    }
    if (!isFinite(minStartSec)) minStartSec = 0;

    for (i = 0; i < tracksByBox.length; i += 1) {
      var tr = tracksByBox[i];
      var n = tr.sizes.length;
      if (!n) continue;

      var totalDur = 0;
      for (var k = 0; k < n; k += 1) totalDur += tr.durs[k];

      var durMs = Math.round((totalDur / tr.timescale) * 1000);
      tr.offsetMs = tr.firstDts == null
        ? 0
        : Math.max(0, Math.round((tr.firstDts / tr.timescale - minStartSec) * 1000));
      if (durMs + tr.offsetMs > maxDurationMs) maxDurationMs = durMs + tr.offsetMs;

      // stts
      var sttsVals = [];
      var runCount = 1;
      var runDur = tr.durs[0];
      for (k = 1; k < n; k += 1) {
        if (tr.durs[k] === runDur) runCount += 1;
        else {
          sttsVals.push(runCount, runDur);
          runCount = 1;
          runDur = tr.durs[k];
        }
      }
      sttsVals.push(runCount, runDur);

      var sttsParts = [new Uint8Array(4)];
      wrU32(sttsParts[0], 0, sttsVals.length / 2);
      var stts = fullBox("stts", 0, 0, [sttsParts[0], u32Array(sttsVals)]);

      // ctts（仅在有合成偏移时）
      var needCtts = false;
      for (k = 0; k < n; k += 1) if (tr.ctos[k] !== 0) { needCtts = true; break; }

      var ctts = null;
      if (needCtts) {
        var negative = false;
        for (k = 0; k < n; k += 1) if (tr.ctos[k] < 0) { negative = true; break; }
        var cttsVals = [];
        var cCount = 1;
        var cVal = tr.ctos[0];
        for (k = 1; k < n; k += 1) {
          if (tr.ctos[k] === cVal) cCount += 1;
          else { cttsVals.push(cCount, cVal >>> 0); cCount = 1; cVal = tr.ctos[k]; }
        }
        cttsVals.push(cCount, cVal >>> 0);
        var cttsHead = new Uint8Array(4);
        wrU32(cttsHead, 0, cttsVals.length / 2);
        ctts = fullBox("ctts", negative ? 1 : 0, 0, [cttsHead, u32Array(cttsVals)]);
      }

      // stsc / stco
      var chunkOffsets = [];
      var stscVals = [];
      var prevCount = -1;
      for (k = 0; k < tr.chunks.length; k += 1) {
        var ch = tr.chunks[k];
        if (ch.count === 0) continue;
        chunkOffsets.push(ch.frag.newPayloadStart + (ch.oldOffset - ch.frag.oldPayloadStart));
        if (ch.count !== prevCount) {
          stscVals.push(chunkOffsets.length, ch.count, 1);
          prevCount = ch.count;
        }
      }

      var use64 = false;
      for (k = 0; k < chunkOffsets.length; k += 1) {
        if (chunkOffsets[k] > U32_MAX) { use64 = true; break; }
      }

      var coHead = new Uint8Array(4);
      wrU32(coHead, 0, chunkOffsets.length);
      var coBox;
      if (use64) {
        var off64 = new Uint8Array(chunkOffsets.length * 8);
        for (k = 0; k < chunkOffsets.length; k += 1) wrU64(off64, k * 8, chunkOffsets[k]);
        coBox = fullBox("co64", 0, 0, [coHead, off64]);
      } else {
        coBox = fullBox("stco", 0, 0, [coHead, u32Array(chunkOffsets)]);
      }

      var scHead = new Uint8Array(4);
      wrU32(scHead, 0, stscVals.length / 3);
      var stsc = fullBox("stsc", 0, 0, [scHead, u32Array(stscVals)]);

      // stsz
      var szHead = new Uint8Array(8);
      wrU32(szHead, 0, 0);
      wrU32(szHead, 4, n);
      var stsz = fullBox("stsz", 0, 0, [szHead, u32Array(tr.sizes)]);

      // stss（有非关键帧时才需要）
      var syncIndices = [];
      var allSync = true;
      for (k = 0; k < n; k += 1) {
        if (tr.syncs[k]) syncIndices.push(k + 1);
        else allSync = false;
      }
      var stss = null;
      if (!allSync && syncIndices.length) {
        var ssHead = new Uint8Array(4);
        wrU32(ssHead, 0, syncIndices.length);
        stss = fullBox("stss", 0, 0, [ssHead, u32Array(syncIndices)]);
      }

      var stblParts = [];
      if (tr.stsd) stblParts.push(tr.stsd);
      stblParts.push(stts);
      if (ctts) stblParts.push(ctts);
      stblParts.push(stsc);
      stblParts.push(stsz);
      stblParts.push(coBox);
      if (stss) stblParts.push(stss);

      tr.newStbl = makeBox("stbl", stblParts);
      tr.totalDur = totalDur;
      tr.durMs = durMs;
    }

    movieTimescale = 1000; // 输出统一用毫秒，避免 timescale 带来的歧义
    var mvhd = mvhdBytes ? mvhdBytes.slice() : makeMvhd(movieTimescale, 0);
    if (mvhd) {
      var mv = mvhd[8];
      if (mv === 0) {
        wrU32(mvhd, 20, movieTimescale);
        wrU32(mvhd, 24, Math.min(maxDurationMs * movieTimescale / 1000, U32_MAX) >>> 0);
      } else {
        wrU32(mvhd, 28, movieTimescale);
        wrU64(mvhd, 32, Math.round(maxDurationMs * movieTimescale / 1000));
      }
    }

    // 6) 组装新的 trak / moov
    var trakBoxes = [];
    for (i = 0; i < tracksByBox.length; i += 1) {
      var t2 = tracksByBox[i];
      if (!t2.newStbl) continue;

      var tkhd = t2.tkhd.slice();
      var mdhd = t2.mdhd.slice();
      var tv = tkhd[8];
      var mv2 = mdhd[8];

      // tkhd 的时长按 mvhd 的 timescale 记（含前导 edit 偏移）
      if (tv === 0) wrU32(tkhd, 28, Math.min(Math.round((t2.durMs + t2.offsetMs) * movieTimescale / 1000), U32_MAX));
      else wrU64(tkhd, 36, Math.round((t2.durMs + t2.offsetMs) * movieTimescale / 1000));

      // mdhd 的时长按自己的 timescale 记
      if (mv2 === 0) wrU32(mdhd, 24, Math.min(t2.totalDur, U32_MAX));
      else wrU64(mdhd, 32, t2.totalDur);

      var minf = makeBox("minf", t2.minfParts.concat([t2.newStbl]));
      var mdia = makeBox("mdia", [mdhd, t2.hdlr, minf]);

      var trakParts = [tkhd];
      if (t2.offsetMs > 0) {
        // 空 edit 把这条轨道的起播时间往后推，保持与其它轨道的相对同步
        var elstBody = new Uint8Array(4);
        wrU32(elstBody, 0, 2);
        var e1 = new Uint8Array(12);
        wrU32(e1, 0, Math.round(t2.offsetMs * movieTimescale / 1000));
        wrU32(e1, 4, 0xffffffff); // media_time = -1 -> 空 edit
        e1[8] = 0; e1[9] = 1; // rate 1.0
        var e2 = new Uint8Array(12);
        wrU32(e2, 0, Math.round(t2.durMs * movieTimescale / 1000));
        wrU32(e2, 4, 0);
        e2[8] = 0; e2[9] = 1;
        trakParts.push(makeBox("edts", [fullBox("elst", 0, 0, [elstBody, e1, e2])]));
      }
      trakParts.push(mdia);
      trakBoxes.push(makeBox("trak", trakParts));
    }

    var moovChildren = [];
    if (mvhd) moovChildren.push(mvhd);
    moovChildren = moovChildren.concat(trakBoxes);
    var newMoov = makeBox("moov", moovChildren);

    // 7) 新的 ftyp（明确标成普通 MP4）
    var newFtyp = makeBox("ftyp", [
      new Uint8Array([0x69, 0x73, 0x6f, 0x6d]), // major_brand: isom
      new Uint8Array([0x00, 0x00, 0x02, 0x00]), // minor_version: 512
      new Uint8Array([0x69, 0x73, 0x6f, 0x6d]), // isom
      new Uint8Array([0x69, 0x73, 0x6f, 0x32]), // iso2
      new Uint8Array([0x61, 0x76, 0x63, 0x31]), // avc1
      new Uint8Array([0x6d, 0x70, 0x34, 0x31]) // mp41
    ]);

    // 8) mdat
    var payloadLen = newPayloadStart;
    var mdatHdrLen = payloadLen + 8 > U32_MAX ? 16 : 8;
    var mdatHead = new Uint8Array(mdatHdrLen);
    if (mdatHdrLen === 8) {
      wrU32(mdatHead, 0, payloadLen + 8);
    } else {
      wrU32(mdatHead, 0, 1);
      mdatHead[4] = 0x6d; mdatHead[5] = 0x64; mdatHead[6] = 0x61; mdatHead[7] = 0x74;
      wrU64(mdatHead, 8, payloadLen + 16);
    }
    if (mdatHdrLen === 8) {
      mdatHead[4] = 0x6d; mdatHead[5] = 0x64; mdatHead[6] = 0x61; mdatHead[7] = 0x74;
    }

    // 9) 把 stco/co64 从"相对 mdat 负载"平移成"文件绝对偏移"
    shiftChunkOffsets(newMoov, newFtyp.length + newMoov.length + mdatHdrLen);

    // 10) 输出
    var out = new Uint8Array(newFtyp.length + newMoov.length + mdatHdrLen + payloadLen);
    var o2 = 0;
    out.set(newFtyp, o2); o2 += newFtyp.length;
    out.set(newMoov, o2); o2 += newMoov.length;
    out.set(mdatHead, o2); o2 += mdatHdrLen;
    for (i = 0; i < good.length; i += 1) {
      var f2 = good[i];
      var slice = buf.subarray(f2.oldPayloadStart, f2.mdatEnd);
      out.set(slice, o2);
      o2 += slice.length;
    }

    var stats = {
      remuxed: true,
      inputSize: len,
      outputSize: out.length,
      durationSeconds: maxDurationMs / 1000,
      tracks: tracksByBox.map(function (t) {
        return {
          trackId: t.trackId,
          handler: t.handler,
          samples: t.sizes.length,
          timescale: t.timescale,
          durationSeconds: t.totalDur ? t.totalDur / t.timescale : 0
        };
      })
    };

    return { data: out, stats: stats };
  }

  function remux(input) {
    return remuxDetailed(input).data;
  }

  return {
    remux: remux,
    remuxDetailed: remuxDetailed,
    fmp4ToMp4: remux,
    version: "1.0.0"
  };
});