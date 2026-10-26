/** 5×7 dot font for digits, the way Patensify draws its hero number. Lit dots are ink; the rest stay faint. */
const GLYPHS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100']
};

export function DotMatrix({
  value,
  dot = 14,
  label
}: {
  value: string;
  dot?: number;
  label: string;
}) {
  const glyphs = value.split('').map((ch) => GLYPHS[ch] ?? GLYPHS['0']!);
  const cols = glyphs.length * 6 - 1;
  const gap = dot * 1.5;
  return (
    <svg
      role="img"
      aria-label={label}
      width={cols * gap}
      height={7 * gap}
      viewBox={`0 0 ${cols * gap} ${7 * gap}`}
      style={{ maxWidth: '100%', height: 'auto' }}
    >
      {glyphs.flatMap((rows, g) =>
        rows.flatMap((row, y) =>
          row
            .split('')
            .map((bit, x) => (
              <circle
                key={`${g}-${x}-${y}`}
                cx={(g * 6 + x) * gap + gap / 2}
                cy={y * gap + gap / 2}
                r={dot / 2}
                fill={bit === '1' ? 'var(--ink)' : 'var(--dot)'}
              />
            ))
        )
      )}
    </svg>
  );
}
