export function renderWorldWandererPluginScript(): string {
  return `      pluginConfigExtras.world_wanderer = {
        html: renderWorldWandererMapBox,
        afterRender: initWorldWandererMap
      };

      function renderWorldWandererMapBox(payload) {
        const path = (payload.runtimeState && payload.runtimeState.pathStack) || [];
        return \`
          <h2>Recent Path</h2>
          <div id="worldWandererMap" class="world-wanderer-map"></div>
          <p id="worldWandererPathMeta" class="world-wanderer-path-meta">\${escapeHtml(worldWandererPathMeta(path, payload.configValue || {}))}</p>
        \`;
      }

      function worldWandererPathMeta(path, config) {
        if (!config.mapsJavaScriptApiKey) return "Set Maps JavaScript API Key to load the map.";
        if (!path.length) return "No path entries yet.";
        const last = path[path.length - 1];
        return path.length + " points, latest " + (last.time || "") + " @ " + Number(last.lat).toFixed(5) + ", " + Number(last.lng).toFixed(5);
      }

      function initWorldWandererMap(payload) {
        const key = payload.configValue && payload.configValue.mapsJavaScriptApiKey;
        const path = ((payload.runtimeState && payload.runtimeState.pathStack) || []).filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng)));
        if (!key || !path.length) return;
        window.__worldWandererMapPayload = { path };
        if (window.google && window.google.maps) {
          drawWorldWandererMap();
          return;
        }
        if (document.getElementById("googleMapsJs")) return;
        const script = document.createElement("script");
        script.id = "googleMapsJs";
        script.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) + "&callback=drawWorldWandererMap";
        script.async = true;
        document.head.appendChild(script);
      }

      function drawWorldWandererMap() {
        const target = $("worldWandererMap");
        const path = (window.__worldWandererMapPayload && window.__worldWandererMapPayload.path) || [];
        if (!target || !path.length || !(window.google && window.google.maps)) return;
        const coords = path.map((point) => ({ lat: Number(point.lat), lng: Number(point.lng) }));
        const map = new google.maps.Map(target, { center: coords[coords.length - 1], zoom: 16, mapTypeId: "roadmap" });
        const bounds = new google.maps.LatLngBounds();
        coords.forEach((coord) => bounds.extend(coord));
        new google.maps.Polyline({ path: coords, map, strokeColor: "#2563eb", strokeOpacity: 0.9, strokeWeight: 4 });
        new google.maps.Marker({ position: coords[0], map, label: "S" });
        new google.maps.Marker({ position: coords[coords.length - 1], map, label: "E" });
        if (coords.length > 1) map.fitBounds(bounds);
      }
      window.drawWorldWandererMap = drawWorldWandererMap;
`;
}
