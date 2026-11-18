/**
 * Normaliza telefone BR pro formato canônico do repo: dígitos E.164 sem "+",
 * COM o 9º dígito (13 dígitos, ex: 5511987654321).
 *
 * Aceita: com/sem +55, com/sem 9º dígito, com máscara. Retorna null quando o
 * número não é normalizável (fixo, curto demais, internacional não-BR etc.) —
 * o chamador decide pular/logar.
 */
export function normalizeBrPhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  // Remove zeros de operadora/discagem (021, 0...)
  digits = digits.replace(/^0+/, '');

  if (digits.startsWith('55') && digits.length >= 12) {
    // já tem DDI
  } else if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  } else {
    return null; // internacional não-BR ou tamanho inválido
  }

  if (digits.length === 13) {
    // 55 + DDD(2) + 9 dígitos — celular completo
    const subscriber = digits.slice(4);
    return subscriber.startsWith('9') ? digits : null;
  }

  if (digits.length === 12) {
    // 55 + DDD(2) + 8 dígitos — celular antigo sem o 9º dígito (assinante 6-9)
    const ddd = digits.slice(2, 4);
    const subscriber = digits.slice(4);
    if (/^[6-9]/.test(subscriber)) return `55${ddd}9${subscriber}`;
    return null; // fixo (2-5) — não recebe WhatsApp de campanha
  }

  return null;
}

/** Países aceitos nos disparos 1:1 (Flow.config.phoneCountries). */
export type PhoneCountry = 'BR' | 'PY';
export const PHONE_COUNTRIES: readonly PhoneCountry[] = ['BR', 'PY'];

/**
 * Normaliza celular do Paraguai (DDI 595): 595 + 9 + 8 dígitos (12 dígitos,
 * ex: 595981123456). Aceita +595, 00595, máscara e o 0 de tronco digitado
 * depois do DDI (595 0981...). Sem DDI ("0981 123 456") é ambíguo com BR e
 * volta null.
 */
export function normalizePyPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
  const m = digits.match(/^5950?(9\d{8})$/);
  return m ? `595${m[1]}` : null;
}

/**
 * Normaliza pelo conjunto de países permitido. Default só BR, idêntico ao
 * normalizeBrPhone: quem não pede PY explicitamente não muda de comportamento.
 * Um número BR nunca casa com o padrão PY (BR com DDI começa com 55; sem DDI
 * tem 10-11 dígitos e não existe DDD 59), então a ordem não importa.
 */
export function normalizePhone(raw: string, countries: readonly PhoneCountry[] = ['BR']): string | null {
  if (countries.includes('PY')) {
    const py = normalizePyPhone(raw);
    if (py) return py;
  }
  return countries.includes('BR') ? normalizeBrPhone(raw) : null;
}
