export type MatriculeKind = 'EMP' | 'ADMIN';

const PREFIXES: Record<MatriculeKind, string> = {
  EMP: 'INOX-EMP',
  ADMIN: 'INOX-ADMIN',
};

export function normalizeMatricule(value?: string) {
  const normalized = value?.trim().toUpperCase();
  return normalized || undefined;
}

export function buildMatricule(kind: MatriculeKind, hiringYear: number, sequence: number) {
  if (!Number.isInteger(hiringYear) || hiringYear < 1900 || hiringYear > 9999) {
    throw new Error('INVALID_HIRING_YEAR');
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 9999) {
    throw new Error('INVALID_MATRICULE_SEQUENCE');
  }
  return `${PREFIXES[kind]}-${hiringYear}-${String(sequence).padStart(4, '0')}`;
}

export function isMatriculeFor(value: string, kind: MatriculeKind, hiringYear: number) {
  const prefix = `${PREFIXES[kind]}-${hiringYear}-`;
  if (!value.startsWith(prefix)) return false;
  const sequence = value.slice(prefix.length);
  return /^[0-9]{4}$/.test(sequence) && sequence !== '0000';
}

export function nextAvailableMatricule(kind: MatriculeKind, hiringYear: number, occupied: Iterable<string>) {
  const prefix = `${PREFIXES[kind]}-${hiringYear}-`;
  const used = new Set<number>();
  for (const value of occupied) {
    if (!value.startsWith(prefix)) continue;
    const sequence = value.slice(prefix.length);
    if (/^[0-9]{4}$/.test(sequence)) used.add(Number(sequence));
  }
  for (let sequence = 1; sequence <= 9999; sequence += 1) {
    if (!used.has(sequence)) return buildMatricule(kind, hiringYear, sequence);
  }
  throw new Error('MATRICULE_SEQUENCE_EPUISEE');
}

export function parseHiringDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('DATE_EMBAUCHE_INVALIDE');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('DATE_EMBAUCHE_INVALIDE');
  }
  const today = new Date().toISOString().slice(0, 10);
  if (value < '1900-01-01' || value > today) throw new Error('DATE_EMBAUCHE_INVALIDE');
  return { value, year: date.getUTCFullYear() };
}
