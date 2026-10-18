// Interactions keeps its existing long-edge policy; GenerateContent uses host geometry.
export function interactionImageRequestTarget(image) {
  if (![image?.width, image?.height].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid image attachment dimensions.')
  const scale = Math.min(1, 2048 / Math.max(image.width, image.height))
  return { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)), maxBytes: 1024 * 1024 }
}
