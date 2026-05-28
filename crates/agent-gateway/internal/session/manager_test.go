package session

import "testing"

func TestApplySettingsJSONPreservingRemoteKeepsDesktopTerminalSetting(t *testing.T) {
	manager := NewManager()
	manager.ApplySettingsJSON(`{"remote":{"enableWebTerminal":true},"theme":"dark"}`)
	if !manager.WebTerminalEnabled() {
		t.Fatal("expected desktop settings sync to enable web terminal")
	}

	manager.ApplySettingsJSONPreservingRemote(`{"remote":{"enableWebTerminal":false},"theme":"light"}`)
	if !manager.WebTerminalEnabled() {
		t.Fatal("settings.update must not disable the desktop-owned web terminal setting")
	}
}

func TestApplySettingsJSONKeepsRemoteWhenPublicSettingsEventOmitsIt(t *testing.T) {
	manager := NewManager()
	manager.ApplySettingsJSON(`{"remote":{"enableWebTerminal":true},"theme":"dark"}`)
	if !manager.WebTerminalEnabled() {
		t.Fatal("expected desktop settings sync to enable web terminal")
	}

	manager.ApplySettingsJSON(`{"theme":"light"}`)
	if !manager.WebTerminalEnabled() {
		t.Fatal("public settings events without remote must not clear the desktop web terminal setting")
	}
}

func TestApplySettingsJSONPreservingRemoteDoesNotTrustIncomingRemote(t *testing.T) {
	manager := NewManager()
	manager.ApplySettingsJSONPreservingRemote(`{"remote":{"enableWebTerminal":true}}`)
	if manager.WebTerminalEnabled() {
		t.Fatal("settings.update must not enable web terminal without a desktop settings snapshot")
	}
}
