export function renderPhotoPluginScript(): string {
  return `      async function pluginAssetBodyForUpload(pluginId, assetKey, file) {
        if (pluginId === "photo" && (assetKey === "character-reference" || assetKey === "on-body-reference" || assetKey === "2dinreal-reference")) {
          return convertImageToJpeg(file, 0.99);
        }
        return file;
      }
`;
}
