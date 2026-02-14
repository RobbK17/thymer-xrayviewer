//Xray Viewer - v1.02
// Show structure of a record in a panel or create a record with its contents

const XCOPY_VERSION = "2025-02-link-display";

class Plugin extends AppPlugin {
  onLoad() {
    this._initXcopy();
    this._initRecordStructureView();
  }

  onUnload() {}

  // --------------------------------------------
  // Xcopy: command only
  // --------------------------------------------
  _initXcopy() {
    if (typeof console !== "undefined" && console.log) {
      try { console.log("[XRay Viewer] loaded", XCOPY_VERSION); } catch (_) {}
    }
    this.ui.addCommandPaletteCommand({
      label: "XRay Viewer: Copy record elements",
      icon: "copy",
      onSelected: async () => {
        try {
          const panel = this.ui.getActivePanel?.();
          const src = panel?.getActiveRecord?.();
          const col = panel?.getActiveCollection?.();

          if (!panel || !src) return this._toast("XRay Viewer", "Open a record first.", 2500);
          if (!col) return this._toast("XRay Viewer", "No active collection found.", 3000);

          const srcGuid = String(src.guid);
          const srcName = src.getName?.() || "Untitled";
          const newTitle = `${srcName} (copy)`;

          const dstGuid = col.createRecord(newTitle);
          if (!dstGuid) return this._toast("XRay Viewer", "Could not create destination record.", 3500);

          const dst = await this._getRecordWithRetry(dstGuid, 40, 150);
          if (!dst) {
            this._toast("XRay Viewer", "Destination record not visible yet. Opening it anyway.", 4500);
            panel.navigateTo({
              type: "edit_panel",
              rootId: dstGuid,
              subId: null,
              workspaceGuid: this.getWorkspaceGuid(),
            });
            return;
          }

          const header = await dst.createLineItem(
            null,
            null,
            "text",
            [{ type: "text", text: `COPY from: ${srcName} (${srcGuid})` }],
            null
          );
          const spacer = await dst.createLineItem(null, header || null, "text", [{ type: "text", text: "" }], null);

          await this._copyRecordProperties(src, dst);

          const getRecord = (guid) => {
            let r = this.data?.getRecord?.(guid);
            if (r) return r;
            r = col?.getRecord?.(guid) ?? col?.getRecordByGuid?.(guid);
            if (r) return r;
            const list =
              col?.getRecords?.() ?? col?.getRecordList?.() ?? col?.records?.() ?? col?.items?.();
            if (Array.isArray(list)) {
              const found = list.find((rec) => rec && (String(rec.guid) === String(guid) || String(rec.id) === String(guid)));
              if (found) return found;
            }
            return null;
          };
          await this._copyBodyTreeAndAppendBackrefs(src, dst, spacer || header || null, {
            srcGuid,
            srcName,
            dstGuid: String(dstGuid),
            getRecord,
          });

          panel.navigateTo({
            type: "edit_panel",
            rootId: dstGuid,
            subId: null,
            workspaceGuid: this.getWorkspaceGuid(),
          });

          this._toast("XRay Viewer", `Created: ${newTitle}`, 2500);
        } catch (e) {
          this._toast("XRay Viewer", `Error: ${String(e?.message || e)}`, 7000);
        }
      },
    });
  }

  // --------------------------------------------
  // Record Structure View: panel type, sidebar, command
  // --------------------------------------------
  _initRecordStructureView() {
    this._structureViewRecordGuid = null;

    this.ui.registerCustomPanelType("record-structure-view", (panel) => {
      this.renderStructurePanel(panel);
    });

    const openStructureView = async () => {
      try {
        const panel = this.ui.getActivePanel();
        const record = panel?.getActiveRecord?.();
        if (!panel || !record) {
          this.ui.addToaster({
            title: "Record Structure",
            message: "Open a record first, then try again.",
            dismissible: true,
            autoDestroyTime: 3500,
          });
          return;
        }
        this._structureViewRecordGuid = record.guid;
        const panels = this.ui.getPanels();
        const rightmost = panels.length > 0 ? panels[panels.length - 1] : null;
        const targetPanel = await this.ui.createPanel({ afterPanel: rightmost });
        if (targetPanel) {
          targetPanel.navigateToCustomType("record-structure-view");
          targetPanel.setTitle("Structure: " + (record.getName() || "Untitled"));
        }
      } catch (e) {
        this.ui.addToaster({
          title: "Record Structure",
          message: "Error: " + String(e),
          dismissible: true,
        });
      }
    };

    this.ui.addSidebarItem({
      label: "Record structure",
      icon: "ti-binary-tree",
      tooltip: "Visualize all elements in the current record",
      onClick: openStructureView,
    });

    this.ui.addCommandPaletteCommand({
      label: "XRay Viewer: Show record elements",
      icon: "pencil",
      onSelected: openStructureView,
    });
  }

  // --------------------------------------------
  // Shared: backreferences (used by both xcopy and structure view)
  // --------------------------------------------
  async _getBackreferenceRecordsNative(srcRecord, excludeGuid) {
    try {
      const fn = srcRecord?.getBackReferenceRecords;
      if (typeof fn !== "function") return [];
      const res = await fn.call(srcRecord);
      if (!Array.isArray(res)) return [];
      const ex = excludeGuid != null ? String(excludeGuid) : "";
      return res.filter((r) => r && (r.guid || r.getGuid) && String(r?.guid || r.getGuid?.() || "") !== ex);
    } catch (_) {
      return [];
    }
  }

  _isLinkLikeLine(typeStr) {
    const t = String(typeStr || "").toLowerCase();
    return t === "linkbtn" || t === "link" || t === "linkobj" || t === "ref" || t === "mention";
  }

  escapeHtml(s) {
    if (s == null) return "";
    const div = document.createElement("div");
    div.textContent = String(s);
    return div.innerHTML;
  }

  /** Fallback: discover backlinks by scanning all records (uses shared _isLinkLikeLine). */
  async discoverBacklinks(targetGuid) {
    if (!targetGuid || typeof this.data.getAllRecords !== "function") return [];
    const allRecords = this.data.getAllRecords();
    const result = [];
    const seenDocs = new Set();
    const target = String(targetGuid);
    const linkTargetKeys = ["recordGuid", "targetGuid", "recordId", "targetId", "guid", "id"];
    const extractGuid = (obj) => {
      if (!obj || typeof obj !== "object") return null;
      for (const k of linkTargetKeys) if (obj[k]) return String(obj[k]);
      if (obj.target && typeof obj.target === "object") {
        for (const k of linkTargetKeys) if (obj.target[k]) return String(obj.target[k]);
      }
      if (obj.obj && typeof obj.obj === "object") {
        for (const k of linkTargetKeys) if (obj.obj[k]) return String(obj.obj[k]);
      }
      return null;
    };

    for (const doc of allRecords) {
      const docGuid = doc.guid ?? doc.getGuid?.();
      if (!docGuid || String(docGuid) === target) continue;
      let items = [];
      try {
        if (typeof doc.getLineItems === "function") items = (await doc.getLineItems()) || [];
      } catch (_) {
        continue;
      }

      for (const item of items) {
        const segments = item.segments || [];
        const props = item.props && typeof item.props === "object" ? item.props : null;
        const itemType = String(item.type || "").toLowerCase();
        const isLinkLike = this._isLinkLikeLine(itemType);

        let pointsHere = false;
        if (isLinkLike && extractGuid(props) === target) pointsHere = true;
        if (!pointsHere) {
          pointsHere = segments.some((seg) => {
            if (!seg || typeof seg !== "object") return false;
            const t = String(seg.type || "").toLowerCase();
            if (!this._isLinkLikeLine(t)) return false;
            return extractGuid(seg) === target;
          });
        }
        if (pointsHere) {
          const docName = typeof doc.getName === "function" ? doc.getName() : (doc.name ?? "Untitled");
          const preview = segments.map((s) => (s && s.text ? s.text : "")).join("").trim().slice(0, 50);
          if (!seenDocs.has(docGuid)) {
            seenDocs.add(docGuid);
            result.push({
              from_document: { guid: docGuid, name: docName },
              from_item: { text: preview || null },
            });
          }
          break;
        }
      }
    }
    return result;
  }

  // --------------------------------------------
  // Record Structure View: panel render
  // --------------------------------------------
  async renderStructurePanel(panel) {
    const element = panel.getElement();
    element.innerHTML = '<div class="rsv-loading"><div class="rsv-spinner"></div><p>Loading record structure…</p></div>';
    this.injectStyles();

    const recordGuid = this._structureViewRecordGuid;
    if (!recordGuid) {
      element.innerHTML = '<div class="rsv-empty">No record selected. Open a record and use "Show record structure" again.</div>';
      return;
    }

    const record = this.data.getRecord(recordGuid);
    if (!record) {
      element.innerHTML = '<div class="rsv-empty">Record not found. It may have been deleted.</div>';
      return;
    }

    let backlinks = [];
    try {
      const nativeRecords = await this._getBackreferenceRecordsNative(record);
      if (nativeRecords.length > 0) {
        backlinks = nativeRecords.map((r) => ({
          from_document: {
            guid: r.guid ?? r.getGuid?.(),
            name: typeof r.getName === "function" ? r.getName() : (r.name ?? r.title ?? "Untitled"),
          },
          from_item: { text: null },
        }));
      }
      if (backlinks.length === 0 && typeof this.data.getAllRecords === "function") {
        backlinks = await this.discoverBacklinks(recordGuid);
      }
    } catch (_) {
      backlinks = [];
    }

    let items = [];
    try {
      items = (await record.getLineItems?.()) || [];
    } catch (err) {
      element.innerHTML = '<div class="rsv-empty">Could not load line items: ' + String(err) + '</div>';
      return;
    }

    const itemGuids = new Set(items.map((i) => i.guid));
    const byParent = new Map();
    byParent.set("__root__", []);

    for (const item of items) {
      const pid = item.parent_guid == null || item.parent_guid === "" || !itemGuids.has(item.parent_guid) ? "__root__" : item.parent_guid;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(item);
    }

    const getPreview = (item) => {
      if (!item.segments || !Array.isArray(item.segments)) return "";
      const text = item.segments.map((s) => (s && s.text ? s.text : "")).join("").trim();
      return text.length > 60 ? text.slice(0, 60) + "…" : text;
    };

    const typeInfo = (type) => {
      const map = {
        task: { label: "Task", icon: "☐", class: "rsv-task" },
        text: { label: "Text", icon: "¶", class: "rsv-text" },
        heading: { label: "Heading", icon: "H", class: "rsv-heading" },
        ulist: { label: "Bullet list", icon: "•", class: "rsv-ulist" },
        olist: { label: "Numbered list", icon: "1.", class: "rsv-olist" },
        quote: { label: "Quote", icon: "\u201C\u201D", class: "rsv-quote" },
        block: { label: "Block", icon: "▢", class: "rsv-block" },
        hr: { label: "Divider", icon: "—", class: "rsv-hr" },
        image: { label: "Image", icon: "🖼", class: "rsv-image" },
        file: { label: "File", icon: "📎", class: "rsv-file" },
        ascii_banner: { label: "Banner", icon: "▤", class: "rsv-banner" },
      };
      return map[type] || { label: type || "Item", icon: "•", class: "rsv-default" };
    };

    const renderNode = (item, depth) => {
      const info = typeInfo(item.type);
      const preview = getPreview(item);
      const children = byParent.get(item.guid) || [];
      const childHtml = children.map((c) => renderNode(c, depth + 1)).join("");
      return '<div class="rsv-node ' + info.class + '" data-depth="' + depth + '"><div class="rsv-node-header"><span class="rsv-icon">' + info.icon + '</span><span class="rsv-type">' + info.label + '</span>' + (preview ? '<span class="rsv-preview">' + this.escapeHtml(preview) + '</span>' : "") + '</div>' + (childHtml ? '<div class="rsv-children">' + childHtml + '</div>' : "") + '</div>';
    };

    const roots = byParent.get("__root__") || [];
    const treeHtml = roots.map((r) => renderNode(r, 0)).join("");
    const summary = items.length + " element" + (items.length === 1 ? "" : "s");

    const blList = backlinks.map((bl) => {
      const doc = bl.from_document || bl.fromDocument || {};
      const docName = this.escapeHtml(doc.name || "Untitled");
      const item = bl.from_item || bl.fromItem;
      const itemPreview = item && item.text ? this.escapeHtml(String(item.text).slice(0, 50)) : null;
      return { docGuid: doc.guid, docName, itemPreview };
    });

    const backlinksHtml = blList.length === 0
      ? '<div class="rsv-backlinks-empty">No other records link to this one.</div>'
      : '<ul class="rsv-backlinks-list">' + blList.map((bl) => '<li class="rsv-backlink-item" data-record-guid="' + this.escapeHtml(bl.docGuid || "") + '"><span class="rsv-backlink-icon">↩</span><span class="rsv-backlink-record">' + bl.docName + '</span>' + (bl.itemPreview ? '<span class="rsv-backlink-context">"' + bl.itemPreview + '…"</span>' : "") + '</li>').join("") + '</ul>';

    element.innerHTML = '<div class="rsv-container"><div class="rsv-summary">' + summary + '</div><div class="rsv-tree">' + treeHtml + '</div><div class="rsv-section rsv-backreferences"><div class="rsv-section-title">↩ Backreferences (' + backlinks.length + ')</div>' + backlinksHtml + '</div></div>';

    element.querySelectorAll(".rsv-backlink-item[data-record-guid]").forEach((el) => {
      const guid = el.getAttribute("data-record-guid");
      if (!guid) return;
      el.style.cursor = "pointer";
      el.addEventListener("click", () => {
        panel.navigateTo({ type: "edit_panel", rootId: guid, subId: null, workspaceGuid: this.getWorkspaceGuid() });
      });
    });
  }

  injectStyles() {
    this.ui.injectCSS(`
.rsv-loading{padding:40px;text-align:center;color:#666}
.rsv-spinner{border:3px solid #eee;border-top-color:#666;border-radius:50%;width:32px;height:32px;margin:0 auto 16px;animation:rsv-spin .8s linear infinite}
@keyframes rsv-spin{to{transform:rotate(360deg)}}
.rsv-empty{padding:24px;color:#666}
.rsv-container{padding:20px;font-size:14px}
.rsv-section{margin-bottom:20px}
.rsv-section-title{font-weight:600;color:#333;margin-bottom:10px;font-size:15px}
.rsv-backreferences{padding:12px;background:#f0f4ff;border-radius:8px;border:1px solid #d0d8f0}
.rsv-backlinks-list{list-style:none;margin:0;padding:0}
.rsv-backlink-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;margin-bottom:4px;background:#fff;border:1px solid #e0e4f0}
.rsv-backlink-item:hover{background:#e8ecff;border-color:#a0b0e0}
.rsv-backlink-icon{color:#06c;font-weight:700}
.rsv-backlink-record{font-weight:600;color:#06c}
.rsv-backlink-context{font-size:12px;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
.rsv-backlinks-empty{color:#666;font-size:13px;padding:4px 0}
.rsv-summary{margin-bottom:16px;font-weight:600;color:#333}
.rsv-tree{font-family:inherit}
.rsv-node{margin-bottom:4px}
.rsv-node-header{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:6px 10px;border-radius:6px;background:#f5f5f5}
.rsv-node[data-depth="0"]>.rsv-node-header{background:#e8e8e8}
.rsv-node[data-depth="1"]>.rsv-node-header{background:#f0f0f0;margin-left:16px}
.rsv-node[data-depth="2"]>.rsv-node-header{margin-left:32px}
.rsv-node[data-depth="3"]>.rsv-node-header{margin-left:48px}
.rsv-children{margin-top:4px}
.rsv-icon{font-weight:700;min-width:1.2em;color:#555}
.rsv-type{font-weight:600;color:#333;min-width:90px}
.rsv-preview{color:#666;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rsv-task .rsv-icon{color:#0a0}
.rsv-heading .rsv-type{color:#06c}
`);
  }

  // --------------------------------------------
  // Xcopy: copy body tree + append backreferences
  // --------------------------------------------
  async _copyBodyTreeAndAppendBackrefs(src, dst, insertAfterRoot, ctx) {
    const items = await src.getLineItems?.();
    let lastRootLine = insertAfterRoot || null;

    if (!Array.isArray(items) || items.length === 0) {
      await this._appendBackreferencesSection(src, dst, lastRootLine, ctx);
      return;
    }

    const allGuids = new Set(items.map((i) => i.guid));
    const childrenByParent = new Map();

    const addChild = (parentGuid, item) => {
      const key = parentGuid || "__ROOT__";
      if (!childrenByParent.has(key)) childrenByParent.set(key, []);
      childrenByParent.get(key).push(item);
    };

    for (const it of items) {
      const p = it?.parent_guid || null;
      if (!p || !allGuids.has(p)) addChild(null, it);
      else addChild(p, it);
    }

    const getChildren = (parentGuid) => childrenByParent.get(parentGuid || "__ROOT__") || [];
    const visited = new Set();

    const copySiblings = async (srcParentGuid, dstParentLine, afterDstSibling, depth) => {
      const siblings = getChildren(srcParentGuid);
      let after = afterDstSibling || null;

      for (const srcLine of siblings) {
        if (!srcLine?.guid) continue;
        if (visited.has(srcLine.guid)) continue;
        visited.add(srcLine.guid);

        const srcType = String(srcLine?.type || "text");
        const isLinkLike = this._isLinkLikeLine(srcType);

        const originalProps =
          srcLine?.props && typeof srcLine.props === "object" ? this._deepClone(srcLine.props) : null;
        const originalSegments = Array.isArray(srcLine?.segments) ? this._deepClone(srcLine.segments) : [];

        const rewritten = isLinkLike
          ? this._rewriteLinkTargetsToGuid(
              { type: srcType, props: originalProps, segments: originalSegments },
              ctx.srcGuid
            )
          : { type: srcType, props: originalProps, segments: originalSegments };

        const segmentsForCreate = isLinkLike
          ? this._cloneSegmentsRaw(rewritten.segments)
          : this._cloneSegmentsSafe(rewritten.segments);

        const propsForCreate =
          rewritten.props && typeof rewritten.props === "object" ? this._deepClone(rewritten.props) : null;

        const created = await this._createLineWithFallbacks(
          dst,
          dstParentLine,
          after,
          rewritten.type,
          segmentsForCreate,
          propsForCreate,
          depth,
          ctx,
          srcLine
        );

        if (!created) {
          const t = String(srcType).toLowerCase();
          if (t === "document" || t === "app") {
            after = await copySiblings(srcLine.guid, dstParentLine, after, depth);
          }
          continue;
        }

        after = created;
        if (!dstParentLine) lastRootLine = created;

        await this._copyLineMeta(srcLine, created);
        await copySiblings(srcLine.guid, created, null, depth + 1);
      }

      return after;
    };

    await copySiblings(null, null, insertAfterRoot || null, 0);
    await this._appendBackreferencesSection(src, dst, lastRootLine, ctx);
  }

  async _appendBackreferencesSection(src, dst, afterRootLine, ctx) {
    let last = afterRootLine || null;

    last = await dst.createLineItem(null, last, "text", [{ type: "text", text: "" }], null);
    last = await dst.createLineItem(null, last, "text", [{ type: "text", text: "### Backreferences" }], null);

    const backrefs = await this._getBackreferenceRecordsNative(src, ctx.dstGuid);

    if (!backrefs.length) {
      await dst.createLineItem(null, last, "text", [{ type: "text", text: "No backreferences found." }], null);
      return;
    }

    const uniq = new Map();
    for (const r of backrefs) {
      const g = r?.guid ? String(r.guid) : null;
      if (!g) continue;
      if (g === String(ctx.dstGuid)) continue;
      const name = r.getName?.() || r.name || r.title || "Unknown Record";
      uniq.set(g, String(name));
    }

    if (!uniq.size) {
      await dst.createLineItem(null, last, "text", [{ type: "text", text: "No backreferences found." }], null);
      return;
    }

    const entries = Array.from(uniq.entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    for (const [id, name] of entries) {
      last = await dst.createLineItem(null, last, "text", [{ type: "text", text: `- ${name} (${id})` }], null);
    }

    await dst.createLineItem(
      null,
      last,
      "text",
      [{ type: "text", text: `Backreferences (unique): ${uniq.size}` }],
      null
    );
  }

  _rewriteLinkTargetsToGuid(line, targetGuid) {
    const tg = String(targetGuid);
    const out = {
      type: String(line?.type || "text"),
      props: line?.props && typeof line.props === "object" ? this._deepClone(line.props) : null,
      segments: Array.isArray(line?.segments) ? this._deepClone(line.segments) : [],
    };

    const keys = ["targetGuid", "recordGuid", "targetId", "recordId", "guid", "id"];

    if (out.props && typeof out.props === "object") {
      if (out.props.self === true) out.props.self = false;
      for (const k of keys) if (k in out.props) out.props[k] = tg;

      if (out.props.target && typeof out.props.target === "object") {
        for (const k of keys) if (k in out.props.target) out.props.target[k] = tg;
      }
      if (out.props.obj && typeof out.props.obj === "object") {
        for (const k of keys) if (k in out.props.obj) out.props.obj[k] = tg;
      }
    }

    for (const seg of out.segments) {
      if (!seg || typeof seg !== "object") continue;
      if (seg.self === true) seg.self = false;

      for (const k of keys) if (k in seg) seg[k] = tg;
      if (seg.obj && typeof seg.obj === "object") {
        for (const k of keys) if (k in seg.obj) seg.obj[k] = tg;
      }
    }

    return out;
  }

  async _createLineWithFallbacks(dst, parentLine, afterLine, type, segments, props, depth, ctx, srcLine) {
    try {
      const li = await dst.createLineItem(parentLine || null, afterLine || null, type, segments, props);
      if (li) return li;
    } catch (_) {}

    try {
      const li = await dst.createLineItem(parentLine || null, afterLine || null, type, segments, null);
      if (li) return li;
    } catch (_) {}

    const summary = this._summarizeSegments(type, segments, props, depth, ctx, srcLine);
    if (summary == null) return null;

    try {
      const li = await dst.createLineItem(
        parentLine || null,
        afterLine || null,
        "text",
        [{ type: "text", text: summary }],
        null
      );
      return li || null;
    } catch (_) {
      return null;
    }
  }

  _looksLikeId(s) {
    if (typeof s !== "string" || !s.trim()) return false;
    const t = s.trim();
    if (t.length < 12) return false;
    if (/^[0-9a-f-]{20,}$/i.test(t)) return true;
    if (/^[0-9A-Za-z]{14,}$/.test(t)) return true;
    return false;
  }

  _getDisplayTextFromLineItem(line) {
    if (!line || typeof line !== "object") return null;
    const methodNames = [
      "getDisplayText", "getLabel", "getTitle", "getText", "getContent",
      "getPlainText", "toText", "getLinkText", "getLinkLabel", "getDisplayLabel",
    ];
    for (const name of methodNames) {
      const fn = line[name];
      if (typeof fn === "function") {
        try {
          const v = fn.call(line);
          if (typeof v === "string" && v.trim() && !this._looksLikeId(v)) return v.trim();
        } catch (_) {}
      }
    }
    const target = line.target ?? line.targetRecord ?? line.record;
    if (target && typeof target === "object") {
      const name = typeof target.getName === "function" ? target.getName() : (target.name ?? target.title ?? target.displayName);
      if (typeof name === "string" && name.trim() && !this._looksLikeId(name)) return name.trim();
    }
    const displayKeys = ["label", "title", "text", "name", "displayText", "content", "caption", "linkText"];
    for (const k of displayKeys) {
      const v = line[k];
      if (typeof v === "string" && v.trim() && !this._looksLikeId(v)) return v.trim();
    }
    for (const [k, v] of Object.entries(line)) {
      if (typeof v !== "string" || !v.trim() || this._looksLikeId(v)) continue;
      if (k === "guid" || k === "id" || k === "parent_guid" || k === "type") continue;
      if (/\s/.test(v) || displayKeys.includes(k)) return v.trim();
    }
    const segs = line.segments ?? line.getSegments?.();
    const prps = line.props ?? line.getProps?.();
    if (segs || prps) {
      const any = this._extractAnyDisplayText(
        Array.isArray(segs) ? segs : [],
        prps && typeof prps === "object" ? prps : null
      );
      if (any && !this._looksLikeId(any)) return any;
    }
    return null;
  }

  _replaceLiteralLinkToken(text, type, segments, props, getRecord, srcLine) {
    if (typeof text !== "string" || !text.includes("[link]")) return text;

    const fromLine = srcLine ? this._getDisplayTextFromLineItem(srcLine) : null;
    if (fromLine) return text.replace(/\[link\]/g, fromLine);

    const targetId = this._extractLinkTargetId(segments, props);
    const recName = this._getRecordNameFromGuid(targetId, getRecord);
    if (recName && !this._looksLikeId(recName)) return text.replace(/\[link\]/g, recName);

    const linkText = this._extractLinkTextFromLine(type, segments, props);
    if (linkText && !this._looksLikeId(linkText)) return text.replace(/\[link\]/g, String(linkText));

    const anyText = this._extractAnyDisplayText(segments, props);
    if (anyText && !this._looksLikeId(anyText)) return text.replace(/\[link\]/g, anyText);

    return text;
  }

  _summarizeSegments(type, segments, props, depth, ctx, srcLine) {
    const t = String(type || "unknown").toLowerCase();
    const prefix = this._indentPrefix(depth);
    const getRecord = ctx?.getRecord;

    const txt = Array.isArray(segments)
      ? segments
          .map((s) => {
            if (!s || typeof s !== "object") return "";
            const v =
              (typeof s.text === "string" && s.text.trim()) ||
              (typeof s.label === "string" && s.label.trim()) ||
              (typeof s.title === "string" && s.title.trim()) ||
              (s.obj && (s.obj.displayName || s.obj.title || s.obj.name));
            return typeof v === "string" ? v : "";
          })
          .join("")
      : "";

    let txtFixed = this._replaceLiteralLinkToken(txt, type, segments, props, getRecord, srcLine);
    if (this._isLinkLikeLine(t) && txtFixed.trim() && this._looksLikeId(txtFixed.trim())) {
      txtFixed = "";
    }
    if (!txtFixed.trim() && (t === "document" || t === "app")) return null;

    if (!txtFixed.trim() && this._isLinkLikeLine(t)) {
      const targetId = this._extractLinkTargetId(segments, props);
      const recName = this._getRecordNameFromGuid(targetId, getRecord);
      const srcGuid = ctx?.srcGuid;
      const srcName = ctx?.srcName;
      const recNameOk =
        recName &&
        !this._looksLikeId(recName) &&
        (String(targetId) === String(srcGuid) || recName !== srcName);
      if (recNameOk) return `${prefix}${recName} (src:${type})`;

      const fromLine = this._getDisplayTextFromLineItem(srcLine);
      const fromLineOk =
        fromLine &&
        !this._looksLikeId(fromLine) &&
        (String(targetId) === String(srcGuid) || fromLine !== srcName);
      if (fromLineOk) return `${prefix}${fromLine} (src:${type})`;

      const linkText = this._extractLinkTextFromLine(type, segments, props);
      if (linkText && !this._looksLikeId(linkText)) return `${prefix}${linkText} (src:${type})`;

      const anyText = this._extractAnyDisplayText(segments, props);
      if (anyText && !this._looksLikeId(anyText)) return `${prefix}${anyText} (src:${type})`;

      if (targetId) return `${prefix}[link → ${targetId}] (src:${type})`;
      if (typeof console !== "undefined" && console.warn) {
        try {
          const lineKeys = srcLine && typeof srcLine === "object" ? Object.keys(srcLine) : [];
          console.warn("[XRay Viewer] link display not found. type:", type, "line keys:", lineKeys, "segments:", JSON.stringify(segments ?? []).slice(0, 200), "props:", JSON.stringify(props ?? {}).slice(0, 200));
        } catch (_) {}
      }
      return `${prefix}[link] (src:${type})`;
    }

    const base = txtFixed.trim() ? txtFixed.trim() : "[uncopiable line]";
    return `${prefix}${base} (src:${type})`;
  }

  _indentPrefix(depth) {
    const d = Math.max(0, Number(depth) || 0);
    return "  ".repeat(d);
  }

  _cloneSegmentsRaw(segments) {
    return this._deepClone(Array.isArray(segments) ? segments : [{ type: "text", text: "" }]);
  }

  _cloneSegmentsSafe(segments) {
    if (!Array.isArray(segments)) return [{ type: "text", text: "" }];

    const out = [];
    for (const seg of segments) out.push(this._sanitizeSegment(seg));
    return out.length ? out : [{ type: "text", text: "" }];
  }

  _sanitizeSegment(seg) {
    try {
      if (!seg || typeof seg !== "object") return { type: "text", text: String(seg ?? "") };

      const type = String(seg.type || "text").toLowerCase();
      const isLink = type === "link" || type === "linkobj" || type === "ref" || type === "mention";

      if (isLink) {
        const targetId =
          (seg.recordGuid || seg.targetGuid || seg.recordId || seg.targetId || seg.guid || seg.id) ??
          (seg.obj && (seg.obj.recordGuid || seg.obj.targetGuid || seg.obj.recordId || seg.obj.targetId || seg.obj.guid || seg.obj.id));

        const recordName = targetId ? this._getRecordNameFromGuid(String(targetId)) : null;

        const urlText =
          (typeof seg.url === "string" && seg.url.trim()) ||
          (typeof seg.href === "string" && seg.href.trim()) ||
          (seg.obj && (seg.obj.url || seg.obj.href));

        const labelText =
          (typeof seg.text === "string" && seg.text.trim()) ||
          (typeof seg.label === "string" && seg.label.trim()) ||
          (typeof seg.title === "string" && seg.title.trim()) ||
          (seg.obj && (seg.obj.displayName || seg.obj.name || seg.obj.title));

        const shown = recordName || (urlText ? String(urlText) : null) || (labelText ? String(labelText) : null) || "link";

        return { type: "text", text: shown };
      }

      const copy = {};
      for (const k of Object.keys(seg)) {
        const v = seg[k];
        copy[k] = typeof v === "object" && v !== null ? this._deepClone(v) : v;
      }
      if (!copy.type) copy.type = "text";
      if (copy.text == null && String(copy.type).toLowerCase() === "text") copy.text = "";
      return copy;
    } catch (_) {
      return { type: "text", text: "[Uncopied segment]" };
    }
  }

  _extractLinkTextFromLine(type, segments, props) {
    const t = String(type || "").toLowerCase();
    if (!this._isLinkLikeLine(t)) return null;

    if (Array.isArray(segments)) {
      for (const s of segments) {
        if (!s || typeof s !== "object") continue;
        const cand =
          (typeof s.text === "string" && s.text.trim()) ||
          (typeof s.label === "string" && s.label.trim()) ||
          (typeof s.title === "string" && s.title.trim()) ||
          (typeof s.displayName === "string" && s.displayName.trim()) ||
          (typeof s.content === "string" && s.content.trim()) ||
          (typeof s.url === "string" && s.url.trim()) ||
          (typeof s.href === "string" && s.href.trim()) ||
          (s.obj && (s.obj.displayName || s.obj.title || s.obj.name || s.obj.url || s.obj.href));
        if (cand && !this._looksLikeId(cand)) return String(cand);
      }
    }

    if (props && typeof props === "object") {
      const displayCand =
        (typeof props.label === "string" && props.label.trim()) ||
        (typeof props.text === "string" && props.text.trim()) ||
        (typeof props.displayText === "string" && props.displayText.trim()) ||
        (typeof props.name === "string" && props.name.trim()) ||
        (typeof props.title === "string" && props.title.trim());
      if (displayCand && !this._looksLikeId(displayCand)) return String(displayCand);

      const urlCand =
        props.url || props.href || props.link || props.permalink || props.openUrl || props.targetUrl || props.to;
      if (urlCand && !this._looksLikeId(String(urlCand))) return String(urlCand);

      if (props.target && typeof props.target === "object") {
        const nested =
          props.target.title || props.target.name || props.target.displayName ||
          props.target.url || props.target.href || props.target.openUrl || props.target.targetUrl;
        if (nested && !this._looksLikeId(String(nested))) return String(nested);
      }
      if (props.obj && typeof props.obj === "object") {
        const nested =
          props.obj.displayName || props.obj.title || props.obj.name ||
          props.obj.url || props.obj.href || props.obj.openUrl || props.obj.targetUrl;
        if (nested && !this._looksLikeId(String(nested))) return String(nested);
      }
    }

    return null;
  }

  _extractAnyDisplayText(segments, props) {
    const skipKeys = new Set([
      "type", "guid", "id", "recordGuid", "targetGuid", "recordId", "targetId", "parent_guid",
      "self", "value", "datetime", "date", "number", "choice",
    ]);
    const guidOrIdLike = /^[0-9a-zA-Z]{14,}$/;
    const hexGuidLike = /^[0-9a-f-]{20,}$/i;
    const nonDisplayTokens = new Set(["link-icons", "table", "linkbtn", "link", "linkobj", "ref", "mention", "text"]);
    const displayKeys = new Set(["text", "label", "title", "name", "displayName", "content", "caption"]);
    const candidates = [];

    const collect = (obj, depth, key) => {
      if (depth > 3 || !obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        for (const item of obj) collect(item, depth + 1, key);
        return;
      }
      for (const [k, v] of Object.entries(obj)) {
        if (skipKeys.has(k)) continue;
        if (typeof v === "string") {
          const s = v.trim();
          if (s.length < 1 || s.length > 300) continue;
          if (hexGuidLike.test(s) || guidOrIdLike.test(s)) continue;
          if (/^\d+$/.test(s)) continue;
          if (nonDisplayTokens.has(s.toLowerCase())) continue;
          const fromDisplayKey = displayKeys.has(k);
          const hasSpace = /\s/.test(s);
          candidates.push({ value: s, fromDisplayKey, hasSpace });
        } else if (v && typeof v === "object") collect(v, depth + 1, k);
      }
    };
    if (Array.isArray(segments)) collect(segments, 0);
    if (props && typeof props === "object") collect(props, 0);
    const best = candidates.find((c) => c.fromDisplayKey || c.hasSpace) || candidates[0];
    return best ? best.value : null;
  }

  _extractLinkTargetId(segments, props) {
    const keys = ["recordGuid", "targetGuid", "recordId", "targetId", "guid", "id"];

    if (props && typeof props === "object") {
      for (const k of keys) if (props[k]) return String(props[k]);
      if (props.target && typeof props.target === "object") {
        for (const k of keys) if (props.target[k]) return String(props.target[k]);
      }
      if (props.obj && typeof props.obj === "object") {
        for (const k of keys) if (props.obj[k]) return String(props.obj[k]);
      }
    }

    if (Array.isArray(segments)) {
      for (const s of segments) {
        if (!s || typeof s !== "object") continue;
        for (const k of keys) if (s[k]) return String(s[k]);
        if (s.obj && typeof s.obj === "object") {
          for (const k of keys) if (s.obj[k]) return String(s.obj[k]);
        }
      }
    }

    return null;
  }

  _getRecordNameFromGuid(guid, getRecord) {
    if (!guid) return null;
    try {
      const resolve = getRecord && typeof getRecord === "function" ? getRecord : (g) => this.data?.getRecord?.(g);
      const rec = resolve(String(guid));
      if (!rec) return null;
      const name = rec.getName?.() || rec.name || rec.title || null;
      if (!name || this._looksLikeId(name)) return null;
      return name;
    } catch (_) {
      return null;
    }
  }

  async _copyLineMeta(srcLine, dstLine) {
    try {
      const status = srcLine.getTaskStatus?.();
      if (status != null && typeof dstLine.setTaskStatus === "function") await dstLine.setTaskStatus(status);

      const blockStyle = srcLine.getBlockStyle?.();
      if (blockStyle != null && typeof dstLine.setBlockStyle === "function") await dstLine.setBlockStyle(blockStyle);

      const headingSize = srcLine.getHeadingSize?.();
      if (headingSize != null && typeof dstLine.setHeadingSize === "function") await dstLine.setHeadingSize(headingSize);
    } catch (_) {}
  }

  async _copyRecordProperties(src, dst) {
    const srcProps = src.getAllProperties?.() || [];
    for (const p of srcProps) {
      const pname = String(p?.name || "").toLowerCase();
      if (pname === "name" || pname === "title") continue;

      const dstProp = dst.prop?.(p.name);
      if (!dstProp || typeof dstProp.set !== "function") continue;

      try {
        const dt = p.datetime?.();
        if (dt != null) {
          const v = typeof dt.value === "function" ? dt.value() : dt;
          dstProp.set(v);
          continue;
        }
        const d = p.date?.();
        if (d != null) {
          dstProp.set(d);
          continue;
        }
        const n = p.number?.();
        if (n != null) {
          dstProp.set(n);
          continue;
        }
        const c = p.choice?.();
        if (c != null) {
          dstProp.set(c);
          continue;
        }
        const t = p.text?.();
        if (t != null) {
          dstProp.set(t);
          continue;
        }
        const fallback = p.value?.();
        if (fallback != null) dstProp.set(fallback);
      } catch (_) {}
    }
  }

  _deepClone(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      if (Array.isArray(obj)) return obj.slice();
      if (obj && typeof obj === "object") return { ...obj };
      return obj;
    }
  }

  async _getRecordWithRetry(guid, attempts, delayMs) {
    for (let i = 0; i < attempts; i++) {
      const rec = this.data.getRecord?.(guid);
      if (rec) return rec;
      await this._sleep(delayMs);
    }
    return null;
  }

  async _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _toast(title, message, ms) {
    this.ui.addToaster?.({ title, message, dismissible: true, autoDestroyTime: ms || 3000 });
  }
}
