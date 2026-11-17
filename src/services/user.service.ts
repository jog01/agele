import type { UserRepository } from "../repositories/user.repository";
import type { AuthClaims } from "./auth.service";

export class UserService {
  constructor(private readonly users: UserRepository) {}

  /** First authenticated request creates the user row. */
  ensureUser(claims: AuthClaims) {
    return this.users.upsertByPrivyDid({ privyDid: claims.privyDid });
  }
}
