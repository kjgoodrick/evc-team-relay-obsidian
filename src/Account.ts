"use strict";

import { presenceColorForUser, type PresenceColor } from "./presenceColor";
export { presencePalette } from "./presenceColor";

export class Account {
	presenceColor: PresenceColor;

	constructor(
		public accountId: string,
		public fullName: string,
		public emailAddress: string,
		public avatarUrl: string,
		public authToken: string,
	) {
		this.presenceColor = presenceColorForUser({ id: accountId });
	}
}
