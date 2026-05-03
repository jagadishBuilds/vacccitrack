import { UserRole, Vaccine, User } from './types';

export const INITIAL_VACCINES: Vaccine[] = [
  { id: 1, name: 'BCG', ageWeeks: 0, doses: 1, desc: 'Bacille Calmette-Guérin – protects against tuberculosis' },
  { id: 2, name: 'Hepatitis B (Birth)', ageWeeks: 0, doses: 1, desc: 'First dose given at birth' },
  { id: 3, name: 'Polio OPV', ageWeeks: 6, doses: 3, desc: 'Oral Polio Vaccine – given at 6, 10, 14 weeks' },
  { id: 4, name: 'DPT (Pentavalent)', ageWeeks: 6, doses: 3, desc: 'Diphtheria, Pertussis, Tetanus + Hib + Hep B' },
  { id: 5, name: 'Pneumococcal (PCV)', ageWeeks: 6, doses: 3, desc: 'Protects against pneumococcal disease' },
  { id: 6, name: 'Rotavirus', ageWeeks: 6, doses: 2, desc: 'Prevents rotavirus diarrhea' },
  { id: 7, name: 'Measles (MR)', ageWeeks: 36, doses: 2, desc: 'Measles-Rubella vaccine at 9 months & 18 months' },
  { id: 8, name: 'Yellow Fever', ageWeeks: 36, doses: 1, desc: 'Given at 9 months in endemic areas' },
  { id: 9, name: 'Vitamin A', ageWeeks: 24, doses: 1, desc: 'Vitamin A supplementation at 6 months' },
];

export const INITIAL_USERS: User[] = [
  { id: 1, username: 'admin', password: 'admin123', fullname: 'Dr. Jagadish Sahu', role: UserRole.ADMIN, active: true },
  { id: 2, username: 'worker', password: 'worker123', fullname: 'Dr. Arya', role: UserRole.WORKER, active: true }
];
