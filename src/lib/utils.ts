export function parseNumber(str: string) {
  const regex = /^(\d+(.\d+)?)\s*(tys\.|mln)?\s*(zł)?$/;
  const matches = str.match(regex);

  if (!matches || matches.length === 0) {
    return -1;
  }

  const number = parseFloat(matches[1]);

  let result = number || -1;

  if (matches.some((el) => el === 'tys.')) {
    result *= 1000;
  }
  if (matches.some((el) => el === 'mln')) {
    result *= 1000000;
  }

  return result;
}
