export function isRasterImageUrl(imageUrl: string): boolean {
  const normalized = imageUrl.toLowerCase();
  return !normalized.endsWith(".svg") && !normalized.startsWith("data:image/svg");
}

export function resolveDefaultImageSource(image: HTMLImageElement): string | null {
  return image.currentSrc || image.src || null;
}
