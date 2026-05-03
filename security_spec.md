# Security Specification for VacciTrack

## 1. Data Invariants
- A `VaccinationRecord` must reference a valid `Child` and a valid `Vaccine`.
- Only `admin` and `worker` roles can create or update `children` and `vaccines`.
- `parents` can only read their own child's data and vaccination records.
- `username` and `id` are unique for users.
- `childId` in a record must match the parent child's ID.

## 2. The "Dirty Dozen" Payloads (Denial Tests)
1. **Identity Spoofing**: Attempt to create a child with `registeredBy` set to another user's ID.
2. **Privilege Escalation**: A `worker` attempting to delete a `vaccine`.
3. **Data Poisoning**: Injecting a 1MB string into the `batchNo` field of a record.
4. **Relational Sync Break**: Creating a `VaccinationRecord` for a non-existent `childId`.
5. **Unauthorized Access**: A `parent` attempting to read another child's records.
6. **State Shortcut**: Updating a `VaccinationRecord` status to `completed` without providing a `batchNo` or `date`.
7. **Bypassing Validation**: Creating a `Vaccine` with a negative `ageWeeks`.
8. **Shadow Field injection**: Adding `isVerified: true` to a child profile update.
9. **Email Spoofing**: Attempting to register a child with an admin's email.
10. **Resource Exhaustion**: Creating a document with a 2KB document ID.
11. **PII Leak**: Unauthenticated user attempting to list all `children`.
12. **History Tampering**: Updating `registeredAt` on a `Child` document.

## 3. Test Runner (Draft)
The `firestore.rules.test.ts` will verify these scenarios.
