export function renderTokenUsageScript(deepSeekPricesCnyPer1M: unknown): string {
  return `      const deepSeekPricesCnyPer1M = ${JSON.stringify(deepSeekPricesCnyPer1M)};

      function renderTokenUsage(payload) {
        const summary = payload.summary || {};
        $("tokenUsageMetrics").innerHTML = [
          renderUsageMetric("Cache Hit Rate", formatPercent(summary.cacheHitRate)),
          renderUsageMetric("Total Tokens", formatNumber(summary.totalTokens)),
          renderUsageMetric("Cost (CNY)", formatCny(actualCnyCost(payload))),
          renderUsageMetric("Cache Hit", formatNumber(summary.cacheHitTokens)),
          renderUsageMetric("Cache Miss", formatNumber(summary.cacheMissTokens)),
          renderUsageMetric("Output", formatNumber(summary.outputTokens))
        ].join("");
        renderTokenUsageModelOptions(payload.byModel || [], payload.model || "all");
        $("tokenUsageChart").innerHTML = renderTokenUsageChart(payload.buckets || []);
        $("tokenUsageModels").innerHTML = renderTokenUsageModels(payload.byModel || []);
        $("tokenUsageLatest").innerHTML = renderTokenUsageLatest(payload.latest || []);
      }

      function renderTokenUsageMetricRows(rows) {
        return rows.map((row) => \`
          <tr>
            <td>\${escapeHtml(row.model || row.createdAt || "")}</td>
            <td>\${escapeHtml(row.agentId || "")}</td>
            <td>\${formatNumber(row.requests || row.totalTokens)}</td>
            <td>\${formatNumber(row.cacheHitTokens)}</td>
            <td>\${formatNumber(row.cacheMissTokens)}</td>
            <td>\${formatPercent(row.cacheHitRate)}</td>
          </tr>
        \`).join("");
      }

      function renderUsageMetric(label, value) {
        return \`<div class="usage-metric"><span class="muted">\${escapeHtml(label)}</span><strong>\${escapeHtml(value)}</strong></div>\`;
      }

      function renderTokenUsageChart(buckets) {
        if (!buckets.length) return "No token usage recorded for this range.";
        const requestTotal = buckets.reduce((sum, bucket) => sum + Number(bucket.requests || 0), 0);
        const tokenTotal = buckets.reduce((sum, bucket) => sum + Number(bucket.totalTokens || 0), 0);
        return \`
          <div class="usage-model-panel">
            <div class="usage-model-charts">
              <div>
                <p class="usage-mini-title">API Requests <span class="usage-model-stat">\${formatNumber(requestTotal)}</span></p>
                \${renderRequestLineChart(buckets)}
              </div>
              <div>
                <p class="usage-mini-title">Tokens <span class="usage-model-stat">\${formatNumber(tokenTotal)}</span></p>
                \${renderTokenBars(buckets)}
              </div>
            </div>
            <div class="usage-legend">
              <span><span class="usage-swatch usage-output"></span>output</span>
              <span><span class="usage-swatch usage-miss"></span>cache miss</span>
              <span><span class="usage-swatch usage-hit"></span>cache hit</span>
            </div>
          </div>
        \`;
      }

      function renderRequestLineChart(buckets) {
        const maxRequests = Math.max(1, ...buckets.map((bucket) => Number(bucket.requests || 0)));
        const width = Math.max(320, buckets.length * 28);
        const height = 140;
        const points = buckets.map((bucket, index) => {
          const x = buckets.length === 1 ? width / 2 : (index / (buckets.length - 1)) * width;
          const y = height - (Number(bucket.requests || 0) / maxRequests) * (height - 10);
          return { x, y, bucket };
        });
        const path = points.map((point, index) => \`\${index === 0 ? "M" : "L"} \${point.x.toFixed(2)} \${point.y.toFixed(2)}\`).join(" ");
        const area = \`\${path} L \${points.at(-1)?.x.toFixed(2) || 0} \${height} L \${points[0]?.x.toFixed(2) || 0} \${height} Z\`;
        return \`
          <div class="usage-line-chart">
            <svg viewBox="0 0 \${width} \${height}" preserveAspectRatio="none">
              <path d="\${escapeAttr(area)}" fill="rgba(22, 119, 255, 0.42)"></path>
              <path d="\${escapeAttr(path)}" fill="none" stroke="#1677ff" stroke-width="3"></path>
              \${points.map((point) => \`<circle cx="\${point.x.toFixed(2)}" cy="\${point.y.toFixed(2)}" r="3" fill="#1677ff"><title>\${escapeHtml(point.bucket.bucket + " requests=" + point.bucket.requests)}</title></circle>\`).join("")}
            </svg>
          </div>
          <div class="usage-axis-row"><span>\${escapeHtml(shortBucketLabel(buckets[0]?.bucket))}</span><span>\${escapeHtml(shortBucketLabel(buckets.at(-1)?.bucket))}</span></div>
        \`;
      }

      function renderTokenBars(buckets) {
        const maxValue = Math.max(1, ...buckets.map((bucket) => Number(bucket.cacheHitTokens || 0) + Number(bucket.cacheMissTokens || 0) + Number(bucket.outputTokens || 0)));
        const bars = buckets.map((bucket) => {
          const hit = Number(bucket.cacheHitTokens || 0);
          const miss = Number(bucket.cacheMissTokens || 0);
          const output = Number(bucket.outputTokens || 0);
          const total = Math.max(1, hit + miss + output);
          const height = Math.max(2, Math.round((total / maxValue) * 140));
          return \`
            <div class="usage-bar-wrap" title="\${escapeAttr(bucket.bucket + " hit=" + hit + " miss=" + miss + " output=" + output + " rate=" + formatPercent(bucket.cacheHitRate))}">
              <div class="usage-bar" style="height:\${height}px">
                <div class="usage-output" style="height:\${Math.round((output / total) * 100)}%"></div>
                <div class="usage-miss" style="height:\${Math.round((miss / total) * 100)}%"></div>
                <div class="usage-hit" style="height:\${Math.round((hit / total) * 100)}%"></div>
              </div>
            </div>
          \`;
        }).join("");
        return \`
          <div class="usage-token-bars">\${bars}</div>
          <div class="usage-axis-row"><span>\${escapeHtml(shortBucketLabel(buckets[0]?.bucket))}</span><span>\${escapeHtml(shortBucketLabel(buckets.at(-1)?.bucket))}</span></div>
        \`;
      }

      function renderTokenUsageModels(rows) {
        if (!rows.length) return "";
        return \`
          <h2>By Model</h2>
          <table class="usage-table">
            <thead><tr><th>Model</th><th>Agent</th><th>Total</th><th>Hit</th><th>Miss</th><th>Hit Rate</th></tr></thead>
            <tbody>\${renderTokenUsageMetricRows(rows.map((row) => ({ ...row, agentId: "all" })))}</tbody>
          </table>
        \`;
      }

      function renderTokenUsageLatest(rows) {
        if (!rows.length) return "";
        return \`
          <h2>Latest Events</h2>
          <table class="usage-table">
            <thead><tr><th>Time</th><th>Agent</th><th>Total</th><th>Hit</th><th>Miss</th><th>Hit Rate</th></tr></thead>
            <tbody>\${renderTokenUsageMetricRows(rows.map((row) => ({ ...row, model: row.createdAt })))}</tbody>
          </table>
        \`;
      }

      function renderTokenUsageModelOptions(rows, selected) {
        const models = ["all", ...rows.map((row) => row.model).filter(Boolean).filter((value, index, list) => list.indexOf(value) === index)];
        $("tokenUsageModel").innerHTML = models.map((model) => \`<option value="\${escapeAttr(model)}" \${model === selected ? "selected" : ""}>\${escapeHtml(model)}</option>\`).join("");
      }

      function shortBucketLabel(value) {
        return String(value || "").replace(/^\\d{4}-/, "").replace("T", " ");
      }

      function formatNumber(value) {
        return Number(value || 0).toLocaleString("en-US");
      }

      function actualCnyCost(payload) {
        const rows = Array.isArray(payload.byModel) && payload.byModel.length
          ? payload.byModel
          : [{ ...(payload.summary || {}), model: payload.model || $("model").value || "deepseek-chat" }];
        return rows.reduce((sum, row) => {
          const price = deepSeekPriceForModel(row.model || "");
          return sum
            + Number(row.cacheHitTokens || 0) * price.hit / 1_000_000
            + Number(row.cacheMissTokens || 0) * price.miss / 1_000_000
            + Number(row.outputTokens || 0) * price.output / 1_000_000;
        }, 0);
      }

      function deepSeekPriceForModel(model) {
        return deepSeekPricesCnyPer1M.find((price) => new RegExp(price.pattern, "i").test(String(model || ""))) || deepSeekPricesCnyPer1M.at(-1);
      }

      function formatCny(value) {
        const digits = value > 0 && value < 1 ? 6 : 2;
        return "¥" + Number(value || 0).toLocaleString("en-US", {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits
        });
      }

      function formatPercent(value) {
        return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 10 + "%" : "unknown";
      }      async function refreshTokenUsage() {
        const params = new URLSearchParams({
          range: $("tokenUsageRange").value,
          bucket: $("tokenUsageBucket").value,
          agent: $("tokenUsageAgent").value,
          model: $("tokenUsageModel").value
        });
        const payload = await fetch("/admin/api/token-usage?" + params.toString()).then((res) => res.json());
        renderTokenUsage(payload);
      }

`;
}
