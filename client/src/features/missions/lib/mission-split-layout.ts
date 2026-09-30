/** Two columns at most; extra missions fill rows in alternating columns.
 * A common row grid lets an odd final column span the full available height. */
export function missionSplitLayout(count: number, width: number) {
  count = Math.max(1, count)
  const columns = count > 1 && width >= 640 ? 2 : 1
  const sizes = Array.from({ length: columns }, (_, column) => Math.ceil((count - column) / columns))
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a
  const rows = sizes.reduce((common, size) => common * size / gcd(common, size), 1)
  const minimumSpan = rows / Math.max(...sizes)
  return { columns, rows, minimumRowHeight: count > 1 ? 220 / minimumSpan : 0,
    placements: Array.from({ length: count }, (_, index) => {
      const column = index % columns
      const span = rows / sizes[column]
      return { gridColumn: column + 1, gridRow: `${Math.floor(index / columns) * span + 1} / span ${span}` }
    }) }
}
