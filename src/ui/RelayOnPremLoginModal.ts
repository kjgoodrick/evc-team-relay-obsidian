/**
 * Relay On-Premise Login Modal
 *
 * Modal dialog for email/password authentication with relay-onprem control plane
 * Supports multi-server mode with optional serverId parameter
 */

import { App, Modal, Notice } from "obsidian";
import type { AuthSession } from "../AuthSession";
import type { RelayOnPremShareClient, OAuthProvider } from "../RelayOnPremShareClient";
import { uiText } from "../wording/uiText";

export class RelayOnPremLoginModal extends Modal {
	private emailInput!: HTMLInputElement;
	private passwordInput!: HTMLInputElement;
	private loginButton!: HTMLButtonElement;
	private errorDiv!: HTMLDivElement;
	private isLoggingIn: boolean = false;
	private oauthProviders: OAuthProvider[] = [];

	constructor(
		app: App,
		private loginManager: AuthSession,
		private onSuccess: () => void,
		private serverId?: string,
		private shareClient?: RelayOnPremShareClient,
		private serverName?: string,
		/**
		 * Set only when this server and its sibling shipped instance are both
		 * present in settings (see crossServerAccountNote() in
		 * RelayOnPremConfig.ts) -- undefined for a user-added server or an
		 * install where the second instance hasn't landed yet.
		 */
		private crossServerNote?: { thisServer: string; otherServer: string },
	) {
		super(app);
		this.setTitle(
			this.serverName
				? uiText("connect.login.title", { server: this.serverName })
				: uiText("connect.login.titleFallback"),
		);
	}

	onOpen() {
		void this._init();
	}

	private async _init() {
		const { contentEl } = this;
		contentEl.empty();

		// Fetch OAuth providers if available
		if (this.shareClient) {
			try {
				this.oauthProviders = await this.shareClient.getOAuthProviders();
			} catch (error: unknown) {
				// OAuth providers not available, continue with password-only login
				console.debug("OAuth providers not available:", error);
			}
		}

		// Cross-server note, above the form -- the reason before the fields,
		// same order the title/note pair reads in.
		if (this.crossServerNote) {
			contentEl.createDiv({
				text: uiText("connect.login.separateAccountsNote", {
					otherServer: this.crossServerNote.otherServer,
					thisServer: this.crossServerNote.thisServer,
				}),
				cls: "evc-text-muted evc-text-sm evc-mb-3",
			});
		}

		// Create form
		const form = contentEl.createEl("form", { cls: "relay-onprem-login-form" });

		// Email field
		const emailGroup = form.createDiv({ cls: "setting-item" });
		emailGroup.createDiv({ cls: "setting-item-info" })
			.createDiv({ text: uiText("connect.login.emailLabel"), cls: "setting-item-name" });
		const emailControl = emailGroup.createDiv({ cls: "setting-item-control" });
		this.emailInput = emailControl.createEl("input", {
			type: "email",
			placeholder: uiText("shared.emailPlaceholder"),
			cls: "relay-onprem-input",
		});
		this.emailInput.addClass("evc-w-full");

		// Password field
		const passwordGroup = form.createDiv({ cls: "setting-item" });
		passwordGroup.createDiv({ cls: "setting-item-info" })
			.createDiv({ text: uiText("shared.passwordLabel"), cls: "setting-item-name" });
		const passwordControl = passwordGroup.createDiv({ cls: "setting-item-control" });
		this.passwordInput = passwordControl.createEl("input", {
			type: "password",
			placeholder: uiText("connect.login.passwordPlaceholder"),
			cls: "relay-onprem-input",
		});
		this.passwordInput.addClass("evc-w-full");

		// Error display
		this.errorDiv = form.createDiv({ cls: "relay-onprem-error" });
		this.errorDiv.addClass("evc-text-error");
		this.errorDiv.addClass("evc-mt-2");
		this.errorDiv.addClass("evc-hidden");

		// Buttons
		const buttonGroup = form.createDiv({ cls: "modal-button-container" });
		buttonGroup.addClass("evc-flex", "evc-justify-end", "evc-mt-4", "evc-gap-2");

		// Cancel button
		const cancelButton = buttonGroup.createEl("button", {
			text: uiText("shared.cancelButton"),
			cls: "mod-cancel",
		});
		cancelButton.addEventListener("click", (e) => {
			e.preventDefault();
			this.close();
		});

		// Login button
		this.loginButton = buttonGroup.createEl("button", {
			text: uiText("connect.login.loginButton"),
			cls: "mod-cta",
		});
		this.loginButton.addEventListener("click", (e) => {
			e.preventDefault();
			void this.handleLogin();
		});

		// Handle Enter key in inputs
		const handleEnter = (e: KeyboardEvent) => {
			if (e.key === "Enter" && !this.isLoggingIn) {
				e.preventDefault();
				void this.handleLogin();
			}
		};
		this.emailInput.addEventListener("keydown", handleEnter);
		this.passwordInput.addEventListener("keydown", handleEnter);

		// Add OAuth buttons if providers are available
		if (this.oauthProviders.length > 0) {
			const oauthSection = form.createDiv({ cls: "relay-onprem-oauth-section evc-oauth-section" });

				oauthSection.createDiv({
					text: uiText("connect.login.orSignInWith"),
					cls: "setting-item-name evc-oauth-label",
				});

				const oauthButtons = oauthSection.createDiv({ cls: "relay-onprem-oauth-buttons" });
				oauthButtons.addClass("evc-flex");
				oauthButtons.addClass("evc-flex-col");
				oauthButtons.addClass("evc-gap-2");

				for (const provider of this.oauthProviders) {
					const oauthButton = oauthButtons.createEl("button", {
						text: provider.display_name,
						cls: "mod-cta",
					});
					oauthButton.addClass("evc-w-full");
					oauthButton.addEventListener("click", (e) => {
						e.preventDefault();
						void this.handleOAuthLogin(provider.name);
					});
				}

		}

		// Focus email input
		window.setTimeout(() => this.emailInput.focus(), 100);
	}

	private async handleLogin() {
		const email = this.emailInput.value.trim();
		const password = this.passwordInput.value;

		// Validation
		if (!email) {
			this.showError(uiText("connect.login.emailRequired"));
			return;
		}

		if (!password) {
			this.showError(uiText("connect.login.passwordRequired"));
			return;
		}

		// Basic email validation
		if (!email.includes("@")) {
			this.showError(uiText("connect.login.invalidEmail"));
			return;
		}

		// Password length validation (control plane requires min 8 characters)
		if (password.length < 8) {
			this.showError(uiText("connect.login.passwordTooShort"));
			return;
		}

		// Attempt login
		this.setLoading(true);
		this.hideError();

		try {
			// Use serverId-specific login if provided, otherwise fall back to legacy method
			if (this.serverId) {
				await this.loginManager.loginToServer(this.serverId, email, password);
			} else {
				await this.loginManager.loginWithEmailAndPassword(email, password);
			}
			new Notice(uiText("connect.login.successNotice"));
			this.close();
			this.onSuccess();
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : uiText("connect.login.loginFailedFallback");
			// Clean up error message for better UX
			let displayMessage = errorMessage;
			if (errorMessage.includes("401") || errorMessage.includes("Incorrect email or password")) {
				displayMessage = this.crossServerNote
					? uiText("connect.login.incorrectCredentialsCrossServer", {
							otherServer: this.crossServerNote.otherServer,
						})
					: uiText("connect.login.incorrectCredentials");
			} else if (errorMessage.includes("400") || errorMessage.includes("Invalid data format")) {
				displayMessage = uiText("connect.login.invalidLoginData");
			} else if (errorMessage.includes("Network request failed") || errorMessage.includes("Failed to fetch")) {
				displayMessage = uiText("connect.login.networkError");
			}
			this.showError(displayMessage);
			this.setLoading(false);
		}
	}

	private setLoading(loading: boolean) {
		this.isLoggingIn = loading;
		this.loginButton.disabled = loading;
		this.emailInput.disabled = loading;
		this.passwordInput.disabled = loading;
		this.loginButton.setText(loading ? uiText("connect.login.loggingIn") : uiText("connect.login.loginButton"));
	}

	private showError(message: string) {
		this.errorDiv.setText(message);
		this.errorDiv.removeClass("evc-hidden");
	}

	private hideError() {
		this.errorDiv.addClass("evc-hidden");
	}

	private async handleOAuthLogin(provider: string) {
		this.setLoading(true);
		this.hideError();

		try {
			// Route through AuthSession (not the authProvider directly) so
			// this.user gets set and notifySubscribers() fires — see // — otherwise main.ts's post-login hook never runs.
			await this.loginManager.loginWithOAuth2(provider, this.serverId);

			new Notice(uiText("connect.login.oauthSuccessNotice", { provider }));
			this.close();
			this.onSuccess();
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : uiText("connect.login.oauthFailedFallback");
			let displayMessage = errorMessage;

			if (errorMessage.includes("timeout")) {
				displayMessage = uiText("connect.login.oauthTimeout");
			} else if (errorMessage.includes("Network request failed") || errorMessage.includes("Failed to fetch")) {
				displayMessage = uiText("connect.login.networkError");
			} else if (errorMessage.includes("Cannot open browser")) {
				displayMessage = uiText("connect.login.oauthCannotOpenBrowser");
			}

			this.showError(displayMessage);
			this.setLoading(false);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
