/**
 * Health Essentials. Pure arithmetic off height + weight — omitted entirely when
 * either is missing, never estimated. Formulas are published ones so they can be
 * checked rather than trusted.
 */
export interface Essentials {
  bmi: number; bmiBand: string; bmiHigh: boolean;
  waterL: number; sleep: string;
  tdee: { sedentary: number; active: number; veryActive: number };
  macros: { protein: string; carbs: string; fats: string; fiber: string };
  goals: { loss: number; gain: number; maintain: number };
}

export function computeEssentials(
  heightCm: number, weightKg: number, ageYears: number, sex: string,
): Essentials {
  const m = heightCm / 100;
  const bmi = weightKg / (m * m);
  // Mifflin-St Jeor
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * ageYears + (sex === 'F' ? -161 : 5);
  const r = (n: number) => Math.round(n);
  const sedentary = r(bmr * 1.2);
  const active = r(bmr * 1.55);
  const veryActive = r(bmr * 1.725);
  return {
    bmi: Math.round(bmi * 10) / 10,
    bmiBand: bmi < 18.5 ? 'Lower' : bmi < 25 ? 'Healthy' : bmi < 30 ? 'Higher' : 'Much higher',
    bmiHigh: bmi >= 25,
    waterL: Math.round(weightKg * 0.035 * 10) / 10,
    sleep: '7-8 Hours',
    tdee: { sedentary, active, veryActive },
    macros: {
      protein: `${r(weightKg * 0.8)}–${r(weightKg * 2.0)}g`,
      carbs: `${r((active * 0.45) / 4)}–${r((active * 0.65) / 4)}g`,
      fats: `${r((active * 0.20) / 9)}–${r((active * 0.35) / 9)}g`,
      fiber: `${r((active / 1000) * 14 * 0.85)}–${r((active / 1000) * 14 * 1.08)}g`,
    },
    goals: { loss: active - 500, gain: active + 500, maintain: active },
  };
}
