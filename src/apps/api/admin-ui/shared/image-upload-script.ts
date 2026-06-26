export function renderImageUploadScript(): string {
  return `      function imageSrcWithCache(src, bustCache) {
        return src && bustCache ? src + (src.includes("?") ? "&" : "?") + "v=" + Date.now() : src;
      }

      function updateImagePreview(preview, imageUrl, bustCache, resolveSrc = (value) => value) {
        if (!preview) return;
        const src = imageSrcWithCache(resolveSrc(imageUrl), bustCache);
        preview.src = src;
        preview.classList.toggle("hidden", !src);
      }

      function imageFileFromTransfer(files, items) {
        return [...(files || [])].find((item) => String(item.type || "").startsWith("image/"))
          || [...(items || [])].map((item) => item.kind === "file" ? item.getAsFile() : undefined).find((item) => String(item?.type || "").startsWith("image/"));
      }

      function bindImageDropZone(drop, onFile, onMissing) {
        if (!drop) return;
        ["dragenter", "dragover"].forEach((name) => {
          drop.addEventListener(name, (event) => {
            event.preventDefault();
            event.stopPropagation();
            drop.classList.add("dragging");
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          });
        });
        ["dragleave", "dragend"].forEach((name) => {
          drop.addEventListener(name, (event) => {
            event.preventDefault();
            event.stopPropagation();
            drop.classList.remove("dragging");
          });
        });
        drop.addEventListener("drop", (event) => {
          event.preventDefault();
          event.stopPropagation();
          drop.classList.remove("dragging");
          const file = imageFileFromTransfer(event.dataTransfer?.files);
          file ? onFile(file) : onMissing("drop");
        });
        drop.addEventListener("paste", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const file = imageFileFromTransfer(event.clipboardData?.files, event.clipboardData?.items);
          file ? onFile(file) : onMissing("paste");
        });
      }

      function convertImageToJpeg(file, quality = 0.92) {
        return new Promise((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const image = new Image();
          image.onload = () => {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = image.naturalWidth || image.width;
              canvas.height = image.naturalHeight || image.height;
              const context = canvas.getContext("2d");
              context.fillStyle = "#fff";
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.drawImage(image, 0, 0);
              canvas.toBlob((blob) => {
                URL.revokeObjectURL(url);
                blob ? resolve(blob) : reject(new Error("image_convert_failed"));
              }, "image/jpeg", quality);
            } catch (error) {
              URL.revokeObjectURL(url);
              reject(error);
            }
          };
          image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("image_load_failed"));
          };
          image.src = url;
        });
      }
`;
}
