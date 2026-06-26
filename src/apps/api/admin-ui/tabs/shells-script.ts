export function renderShellsScript(): string {
  return `      let shellData = null;
      let shellOrder = { personalities: [], relationships: [], outfits: [] };
      const shellCategories = [
        { key: "personalities", title: "性格 / 语气" },
        { key: "relationships", title: "关系 / 称呼" },
        { key: "outfits", title: "服装 / Cosplay" }
      ];

      async function refreshShellEditor() {
        const [data, orderPayload] = await Promise.all([
          fetch("/admin/api/shell").then((res) => res.json()),
          fetch("/admin/api/shell-ui/order").then((res) => res.json())
        ]);
        shellData = data;
        shellOrder = orderPayload.order || shellOrder;
        shellCategories.forEach((category) => {
          shellData[category.key] = applyShellOrder(category.key, shellData[category.key] || []);
        });
        renderShellEditor();
      }

      function renderShellEditor() {
        if (!shellData) return;
        $("shellEditor").innerHTML = \`
          <div class="shell-head">
            <h2>Daily Shell</h2>
            <button type="button" id="shell-reroll" class="secondary">Reroll Today</button>
          </div>
          <details class="prompt-layer">
            <summary>Today<span>\${escapeHtml(shellData.daily?.date || "")}</span></summary>
            <p class="muted">Created at: \${escapeHtml(shellData.daily?.createdAt || "")}</p>
            <pre>\${escapeHtml(JSON.stringify(shellData.todayVariables || {}, null, 2))}</pre>
          </details>
          <details class="prompt-layer">
            <summary>Shell Settings<span>daily refresh clock</span></summary>
            <label for="shellRolloverHour">Daily Refresh Clock (0-23)</label>
            <input id="shellRolloverHour" inputmode="numeric" value="\${escapeAttr(shellData.settings?.rolloverHour ?? 4)}" />
            <button type="button" id="shell-settings-save">Save Shell Settings</button>
          </details>
          <details class="prompt-layer" open>
            <summary>语气 / 称呼<span>top</span></summary>
            <div class="shell-grid">
              \${shellCategories.slice(0, 2).map((category) => renderShellCategory(category)).join("")}
            </div>
          </details>
          <details class="prompt-layer" open>
            <summary>服装<span>bottom</span></summary>
            \${renderShellCategory(shellCategories[2])}
          </details>
        \`;
        $("shell-reroll").addEventListener("click", rerollShell);
        $("shell-settings-save").addEventListener("click", saveShellSettings);
        shellCategories.forEach((category) => bindShellCategory(category.key));
      }

      function renderShellCategory(category) {
        const options = shellData[category.key] || [];
        return \`
          <div class="prompt-layer shell-category-\${escapeAttr(category.key)}" data-shell-category="\${escapeAttr(category.key)}">
            <div class="shell-head">
              <h2>\${escapeHtml(category.title)}</h2>
              <span class="muted" data-shell-category-count>\${options.length} options</span>
            </div>
            <div class="shell-category-body">
              \${renderShellGroups(category.key, options)}
            </div>
          </div>
        \`;
      }

      function renderShellGroups(category, options) {
        const groups = new Map();
        options.forEach((option, index) => {
          const group = option.group || "root";
          if (!groups.has(group)) groups.set(group, []);
          groups.get(group).push({ option, index });
        });
        return [...groups.entries()].map(([group, items]) => renderShellGroup(category, group, items)).join("");
      }

      function renderShellGroup(category, group, items = shellGroupItems(category, group), open = false) {
        return \`
          <details class="shell-group" data-shell-group="\${escapeAttr(group)}" \${open ? "open" : ""}>
            <summary>
              <strong>\${escapeHtml(group)}</strong>
              <div class="shell-group-actions">
                <span class="muted" data-shell-group-count>\${items.length} items</span>
                <button type="button" class="shell-group-add" data-action="add-group" data-shell-group-add="\${escapeAttr(group)}" title="Add to \${escapeAttr(group)}" aria-label="Add to \${escapeAttr(group)}">+</button>
              </div>
            </summary>
            \${items.map(({ option, index }) => renderShellOption(category, option, index)).join("")}
          </details>
        \`;
      }

      function shellGroupItems(category, group) {
        return (shellData[category] || [])
          .map((option, index) => ({ option, index }))
          .filter(({ option }) => (option.group || "root") === group);
      }

      function applyShellOrder(category, options) {
        const order = shellOrder[category] || [];
        if (!order.length) return options;
        const byId = new Map(options.map((option) => [option.id, option]));
        const sorted = order.map((id) => byId.get(id)).filter(Boolean);
        const seen = new Set(sorted.map((option) => option.id));
        return [...sorted, ...options.filter((option) => !seen.has(option.id))];
      }

      function renderShellOption(category, option, index) {
        return \`
          <details class="shell-option" data-shell-index="\${index}">
            <summary>
              <span class="shell-title">\${escapeHtml(option.name || "New Shell")}</span>
              <span class="shell-marker" data-field="marker"></span>
              <button type="button" data-action="up" title="Move up">↑</button>
              <button type="button" data-action="down" title="Move down">↓</button>
              <button type="button" class="shell-save" data-action="save-one" title="Save">S</button>
            </summary>
            <div class="row">
              <div>
                <label>ID</label>
                <input data-field="id" value="\${escapeAttr(option.id || "")}" />
              </div>
              <div></div>
            </div>
            <label>Name</label>
            <input data-field="name" value="\${escapeAttr(option.name || "")}" />
            <label>Group</label>
            <input data-field="group" value="\${escapeAttr(option.group || "")}" placeholder="root / 原神 / ..." />
            \${category === "outfits" ? \`
              <div class="shell-outfit-images">
                <div class="shell-image-box">
                  <label>Image</label>
                  <div class="shell-image-drop" data-field="imageDrop" tabindex="0">
                    <span class="muted">拖入或粘贴图片自动上传</span>
                    <img class="shell-image-preview \${option.imageUrl ? "" : "hidden"}" data-field="imagePreview" src="\${escapeAttr(shellImageSrc(option.imageUrl || ""))}" alt="" />
                  </div>
                </div>
                <div class="shell-image-box">
                  <label>穿着参考</label>
                  <div class="shell-on-body-box">
                    <img class="shell-image-preview \${option.onBodyImageUrl ? "" : "hidden"}" data-field="onBodyPreview" src="\${escapeAttr(shellImageSrc(option.onBodyImageUrl || ""))}" alt="" />
                    <label><input type="checkbox" data-field="outfitImageGenerated" \${option.outfitImageGenerated ? "checked" : ""} /> 当前服装本身已是生成结果</label>
                    <button type="button" data-action="generate-on-body" \${option.outfitImageGenerated ? "disabled" : ""}>生成</button>
                    <p class="muted shell-on-body-status" data-field="onBodyStatus">\${option.outfitImageGenerated ? "已禁用生成" : ""}</p>
                  </div>
                </div>
              </div>
            \` : ""}
            <label>Content</label>
            <textarea data-field="content" rows="6">\${escapeHtml(option.content || "")}</textarea>
            <button type="button" data-action="delete" class="secondary">Delete</button>
          </details>
        \`;
      }

      function bindShellCategory(category) {
        const root = document.querySelector('[data-shell-category="' + cssEscape(category) + '"]');
        if (!root) return;
        root.querySelectorAll(".shell-group").forEach((groupRoot) => bindShellGroup(groupRoot, category));
      }

      function bindShellGroup(groupRoot, category) {
        if (!groupRoot) return;
        groupRoot.querySelector('[data-action="add-group"]')?.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const group = event.currentTarget.dataset.shellGroupAdd || "root";
          shellData[category].push({ id: category.slice(0, -1) + "_" + Date.now(), name: "New Shell", content: "", group });
          rerenderShellGroup(category, group, true);
          updateShellCategoryCount(category);
        });
        groupRoot.querySelectorAll(".shell-option").forEach((optionRoot) => bindShellOption(optionRoot, category));
      }

      function rerenderShellGroup(category, group, open) {
        const categoryRoot = document.querySelector('[data-shell-category="' + cssEscape(category) + '"]');
        const groupRoot = categoryRoot?.querySelector('[data-shell-group="' + cssEscape(group) + '"]');
        const items = shellGroupItems(category, group);
        if (!items.length) {
          groupRoot?.remove();
          return;
        }
        const shouldOpen = open ?? Boolean(groupRoot?.open);
        const html = renderShellGroup(category, group, items, shouldOpen);
        if (groupRoot) groupRoot.outerHTML = html;
        else categoryRoot?.querySelector(".shell-category-body")?.insertAdjacentHTML("beforeend", html);
        bindShellGroup(categoryRoot?.querySelector('[data-shell-group="' + cssEscape(group) + '"]'), category);
      }

      function updateShellCategoryCount(category) {
        const categoryRoot = document.querySelector('[data-shell-category="' + cssEscape(category) + '"]');
        const categoryCount = categoryRoot?.querySelector("[data-shell-category-count]");
        if (categoryCount) categoryCount.textContent = shellData[category].length + " options";
      }

      function bindShellOption(optionRoot, category) {
        if (!optionRoot) return;
        const index = Number(optionRoot.dataset.shellIndex);
        const option = shellData[category][index];
        option._previousId = option._previousId || option.id;
        optionRoot.querySelector('[data-field="id"]').addEventListener("input", (event) => { option.id = event.target.value; markShellOption(optionRoot, "dirty"); });
        optionRoot.querySelector('[data-field="name"]').addEventListener("input", (event) => { option.name = event.target.value; markShellOption(optionRoot, "dirty"); });
        optionRoot.querySelector('[data-field="group"]').addEventListener("input", (event) => { option.group = event.target.value; markShellOption(optionRoot, "dirty"); });
        bindShellImageDrop(optionRoot, option, category, index);
        bindShellOnBodyGenerate(optionRoot, option, category, index);
        const generatedCheckbox = optionRoot.querySelector('[data-field="outfitImageGenerated"]');
        if (generatedCheckbox) {
          generatedCheckbox.addEventListener("change", async (event) => {
            option.outfitImageGenerated = event.target.checked;
            updateShellOnBodyGenerateDisabled(optionRoot, option.outfitImageGenerated);
            setShellOnBodyStatus(optionRoot, "Saving generated flag...");
            generatedCheckbox.disabled = true;
            try {
              const saved = await persistShellOption(category, currentShellIndex(optionRoot));
              shellData[category][currentShellIndex(optionRoot)] = { ...saved.option, _previousId: saved.option.id };
              markShellOption(optionRoot, "saved");
              setShellOnBodyStatus(optionRoot, option.outfitImageGenerated ? "已禁用生成" : "Generated flag saved.");
            } catch (error) {
              setShellOnBodyStatus(optionRoot, "Save failed: " + (error?.message || "unknown error"));
            } finally {
              generatedCheckbox.disabled = false;
            }
          });
        }
        optionRoot.querySelector('[data-field="content"]').addEventListener("input", (event) => { option.content = event.target.value; markShellOption(optionRoot, "dirty"); });
        optionRoot.querySelector('[data-action="save-one"]').addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          try {
            await saveShellOption(category, currentShellIndex(optionRoot));
          } catch (error) {
            $("shell-status").textContent = "Shell save failed: " + (error?.message || "unknown error");
          }
        });
        optionRoot.querySelector('[data-action="up"]').addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          moveShellOption(category, currentShellIndex(optionRoot), -1).catch((error) => {
            $("shell-status").textContent = "Shell order save failed: " + (error?.message || "unknown error");
          });
        });
        optionRoot.querySelector('[data-action="down"]').addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          moveShellOption(category, currentShellIndex(optionRoot), 1).catch((error) => {
            $("shell-status").textContent = "Shell order save failed: " + (error?.message || "unknown error");
          });
        });
        optionRoot.querySelector('[data-action="delete"]').addEventListener("click", async () => {
          if (shellData[category].length <= 1) {
            $("shell-status").textContent = "Each shell category must keep at least one option.";
            return;
          }
          try {
            await deleteShellOption(category, currentShellIndex(optionRoot));
          } catch (error) {
            $("shell-status").textContent = "Shell delete failed: " + (error?.message || "unknown error");
          }
        });
      }

      async function moveShellOption(category, index, delta) {
        const options = shellData[category];
        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= options.length) return;
        const current = options[index];
        options[index] = options[nextIndex];
        options[nextIndex] = current;
        await saveShellOrder(category);
        $("shell-status").textContent = "Shell order saved.";
        moveShellOptionNode(category, index, nextIndex, delta);
      }

      async function saveShellOption(category, index) {
        const optionRoot = document.querySelector('[data-shell-category="' + cssEscape(category) + '"] [data-shell-index="' + index + '"]');
        const option = shellData[category][index];
        const previousGroup = option?.group || "root";
        const result = await persistShellOption(category, index);
        $("shell-status").textContent = "Shell saved: " + (option?.name || option?.id || category);
        shellData[category][index] = { ...result.option, _previousId: result.option.id };
        const nextGroup = result.option.group || "root";
        if (previousGroup !== nextGroup) {
          rerenderShellGroup(category, previousGroup);
          rerenderShellGroup(category, nextGroup, true);
          return;
        }
        optionRootLabel(category, index, result.option);
        if (optionRoot) {
          markShellOption(optionRoot, "saved");
          optionRoot.open = false;
        }
      }

      async function persistShellOption(category, index) {
        const option = shellData[category][index];
        const previousId = option?._previousId || option?.id;
        const payload = { ...option };
        delete payload._previousId;
        const result = await fetch("/admin/api/shell-option", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, previousId, option: payload })
        }).then((res) => res.json());
        if (!result.ok) throw new Error(result.error || "unknown error");
        shellData[category][index] = { ...result.option, _previousId: result.option.id };
        return result;
      }

      async function deleteShellOption(category, index) {
        const option = shellData[category][index];
        const id = option?._previousId || option?.id;
        const result = await fetch("/admin/api/shell-option", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, id })
        }).then((res) => res.json());
        if (!result.ok) throw new Error(result.error || "unknown error");
        shellData[category].splice(index, 1);
        shellOrder = result.order || shellOrder;
        $("shell-status").textContent = "Shell deleted: " + (option?.name || id || category);
        rerenderShellGroup(category, option?.group || "root");
        updateShellCategoryCount(category);
      }

      function optionRootLabel(category, index, option) {
        const root = document.querySelector('[data-shell-category="' + cssEscape(category) + '"] [data-shell-index="' + index + '"] .shell-title');
        if (root) root.textContent = option.name || "New Shell";
      }

      function markShellOption(optionRoot, state) {
        const marker = optionRoot.querySelector('[data-field="marker"]');
        if (!marker) return;
        marker.textContent = state === "dirty" ? "[●]" : state === "saved" ? "[M]" : "";
      }

      function moveShellOptionNode(category, index, nextIndex, delta) {
        const root = document.querySelector('[data-shell-category="' + cssEscape(category) + '"]');
        const current = root?.querySelector('[data-shell-index="' + index + '"]');
        const target = root?.querySelector('[data-shell-index="' + nextIndex + '"]');
        if (!current || !target || !current.parentElement || current.parentElement !== target.parentElement) return;
        if (delta < 0) {
          target.before(current);
        } else {
          target.after(current);
        }
        current.dataset.shellIndex = String(nextIndex);
        target.dataset.shellIndex = String(index);
      }

      function currentShellIndex(optionRoot) {
        return Number(optionRoot.dataset.shellIndex);
      }

      async function saveShellOrder(category) {
        shellOrder[category] = shellData[category].map((option) => option.id);
        const result = await fetch("/admin/api/shell-ui/order", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ category, order: shellOrder[category] })
        }).then((res) => res.json());
        if (!result.ok) throw new Error(result.error || "unknown error");
        shellOrder = result.order || shellOrder;
      }

      function shellImageSrc(imageUrl) {
        const value = String(imageUrl || "");
        if (!value) return "";
        if (/^https?:\\/\\//.test(value) || value.startsWith("data:")) return value;
        const prefix = "memory-files/shell/";
        if (value.startsWith(prefix)) return "/admin/assets/shell/" + value.slice(prefix.length).split("/").map(encodeURIComponent).join("/");
        return value;
      }

      function updateShellImagePreview(optionRoot, imageUrl, bustCache) {
        updateImagePreview(optionRoot.querySelector('[data-field="imagePreview"]'), imageUrl, bustCache, shellImageSrc);
      }
      function updateShellOnBodyPreview(optionRoot, imageUrl, bustCache) {
        updateImagePreview(optionRoot.querySelector('[data-field="onBodyPreview"]'), imageUrl, bustCache, shellImageSrc);
      }
      function setShellOnBodyStatus(optionRoot, message) {
        const status = optionRoot.querySelector('[data-field="onBodyStatus"]');
        if (status) status.textContent = message || "";
        if ($("shell-status")) $("shell-status").textContent = message || "";
      }

      function updateShellOnBodyGenerateDisabled(optionRoot, disabled) {
        const button = optionRoot.querySelector('[data-action="generate-on-body"]');
        if (button) button.disabled = Boolean(disabled);
      }

      async function rerollShell() {
        const result = await fetch("/admin/api/shell/reroll", { method: "POST" }).then((res) => res.json());
        $("shell-status").textContent = result.todayVariables ? "Daily shell rerolled." : "Daily shell reroll failed.";
        shellData = result;
        renderShellEditor();
        await refreshPromptProfile();
        await refreshLLMRequests();
      }

      async function saveShellSettings() {
        const result = await fetch("/admin/api/shell-settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rolloverHour: Number($("shellRolloverHour").value) })
        }).then((res) => res.json());
        $("shell-status").textContent = result.ok ? "Shell settings saved." : "Shell settings save failed: " + (result.error || "unknown error");
        if (result.ok) {
          shellData = result;
          renderShellEditor();
        }
      }

      async function uploadShellOutfitImage(optionRoot, option, category, index, file) {
        if (!file) {
          $("shell-status").textContent = "Drop an image file.";
          return;
        }
        if (!String(file.type || "").startsWith("image/")) {
          $("shell-status").textContent = "Drop an image file.";
          return;
        }
        $("shell-status").textContent = "Uploading image...";
        const imageBlob = await convertImageToJpeg(file);
        const result = await fetch("/admin/api/shell/outfit-image", {
          method: "POST",
          headers: {
            "content-type": "image/jpeg",
            "x-shell-id": encodeURIComponent(option.id || "outfit")
          },
          body: imageBlob
        }).then((res) => res.json());
        if (!result.ok) {
          $("shell-status").textContent = "Image upload failed: " + (result.error || "unknown error");
          return;
        }
        option.imageUrl = result.imageUrl;
        updateShellImagePreview(optionRoot, result.imageUrl, true);
        const saved = await persistShellOption(category, index);
        shellData[category][index] = { ...saved.option, _previousId: saved.option.id };
        optionRootLabel(category, index, saved.option);
        markShellOption(optionRoot, "saved");
        $("shell-status").textContent = "Image uploaded and saved: " + (saved.option.name || saved.option.id || "outfit");
      }

      function bindShellImageDrop(optionRoot, option, category, index) {
        const drop = optionRoot.querySelector('[data-field="imageDrop"]');
        bindImageDropZone(drop, (file) => {
          uploadShellOutfitImage(optionRoot, option, category, index, file).catch((error) => {
            $("shell-status").textContent = "Image upload failed: " + (error?.message || "unknown error");
          });
        }, (kind) => {
          $("shell-status").textContent = kind === "paste" ? "Paste an image file." : "Drop an image file.";
        });
      }
      function bindShellOnBodyGenerate(optionRoot, option, category, index) {
        const button = optionRoot.querySelector('[data-action="generate-on-body"]');
        if (!button) return;
        button.addEventListener("click", async () => {
          if (option.outfitImageGenerated) {
            setShellOnBodyStatus(optionRoot, "已禁用生成");
            updateShellOnBodyGenerateDisabled(optionRoot, true);
            return;
          }
          if (!option.imageUrl) {
            setShellOnBodyStatus(optionRoot, "Generate failed: missing outfit image.");
            return;
          }
          button.disabled = true;
          setShellOnBodyStatus(optionRoot, "Generating on-body image...");
          try {
            const response = await fetch("/admin/api/plugins/photo/on-body", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                outfitId: option.id,
                outfitName: option.name,
                outfitContent: option.content,
                outfitGroup: option.group,
                outfitImageUrl: option.imageUrl,
                onBodyImageUrl: option.onBodyImageUrl,
                outfitImageGenerated: option.outfitImageGenerated
              })
            });
            const text = await response.text();
            const result = text ? JSON.parse(text) : {};
            if (!result.ok) {
              setShellOnBodyStatus(optionRoot, "Generate failed: " + (result.error || response.statusText || "unknown error"));
              return;
            }
            option.onBodyImageUrl = result.imageUrl;
            updateShellOnBodyPreview(optionRoot, result.imageUrl, true);
            const saved = await persistShellOption(category, index);
            shellData[category][index] = { ...saved.option, _previousId: saved.option.id };
            markShellOption(optionRoot, "saved");
            setShellOnBodyStatus(optionRoot, "On-body image generated: " + result.imageUrl);
          } catch (error) {
            setShellOnBodyStatus(optionRoot, "Generate failed: " + (error?.message || "unknown error"));
          } finally {
            updateShellOnBodyGenerateDisabled(optionRoot, Boolean(option.outfitImageGenerated));
          }
        });
      }
`;
}
