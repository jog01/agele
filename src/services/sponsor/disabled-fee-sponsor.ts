import { type FeeSponsor, SponsorRejectedError } from "./fee-sponsor";

export class DisabledFeeSponsor implements FeeSponsor {
  readonly feePayer = "";

  async register(): Promise<{ expiresAt: number }> {
    throw new SponsorRejectedError("sponsor_disabled");
  }

  async cosign(): Promise<string> {
    throw new SponsorRejectedError("sponsor_disabled");
  }
}
