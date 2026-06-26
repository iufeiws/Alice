export function renderPhotoPluginScript(): string {
  return `      async function pluginAssetBodyForUpload(pluginId, assetKey, file) {
        if (pluginId === "photo" && (assetKey === "character-reference" || assetKey === "on-body-reference")) {
          return convertImageToJpeg(file, 0.99);
        }
        return file;
      }
`;
}
