import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function calcAge(dob: string) {
  const d = new Date(dob);
  const now = new Date();
  let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) months--;
  if (months < 0) months = 0;
  if (months < 1) {
    const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
    return days + 'd';
  }
  if (months < 24) return months + 'mo';
  return Math.floor(months / 12) + 'yr';
}

export function calcAgeWeeks(dob: string) {
  const d = new Date(dob);
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (86400000 * 7));
}

export function formatDate(d?: string | Date) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
