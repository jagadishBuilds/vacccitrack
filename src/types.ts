
export enum UserRole {
  ADMIN = 'admin',
  WORKER = 'worker',
  PARENT = 'parent',
}

export interface User {
  id: number | string;
  username: string;
  password?: string;
  fullname: string;
  role: UserRole;
  active: boolean;
  authUid?: string;
  email?: string;
}

export interface Vaccine {
  id: string | number;
  name: string;
  ageWeeks: number;
  doses: number;
  desc: string;
}

export interface Child {
  id: string | number;
  name: string;
  dob: string;
  gender: string;
  guardian: string;
  phone: string;
  email: string;
  address: string;
  state: string;
  city: string;
  locality: string;
  hospital: string;
  parentPassword?: string;
  registeredBy: string;
  registeredAt: string;
}

export interface VaccinationRecord {
  childId: string | number;
  vaccineId: string | number;
  status: 'completed' | 'pending';
  date?: string;
  batchNo?: string;
  administeredBy?: string;
  notes?: string;
  updatedBy: string;
  updatedAt: string;
}

export interface EmailJSConfig {
  publicKey: string;
  serviceId: string;
  templateId: string;
}

export interface ReminderLog {
  childId: string | number;
  vaccineId: string | number;
  email: string;
  status: 'sent' | 'failed';
  sentAt: string;
  sentBy: string;
}
