use std::collections::{HashMap, HashSet};

const MAX_PARKED_PER_WINDOW: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneOwner {
    pub window_label: String,
    pub owner_id: String,
    /// Stable native identity, including across reparenting and owner-id reuse.
    pub pane_label: String,
}

#[derive(Default)]
pub struct BrowserOwners {
    panes: HashMap<String, PaneOwner>,
    /// Oldest first. Parking retains the native session and popup relationship.
    parked: HashMap<String, Vec<PaneOwner>>,
    popups: HashMap<String, String>,
    presented: HashSet<String>,
}

impl BrowserOwners {
    pub fn active(&self, window: &str) -> Option<PaneOwner> { self.panes.get(window).cloned() }
    pub fn resume_candidate(&self, window: &str) -> Option<PaneOwner> {
        self.active(window).or_else(|| self.parked.get(window)?.last().cloned())
    }
    pub fn for_window(&self, window: &str, owner: &str) -> Option<PaneOwner> {
        self.panes.get(window).filter(|pane| pane.owner_id == owner).cloned()
    }
    pub fn mount(&self, window: &str, owner: &str) -> Option<PaneOwner> {
        self.for_window(window, owner).or_else(|| self.parked.get(window)?.iter().find(|pane| pane.owner_id == owner).cloned())
    }
    pub fn for_pane(&self, label: &str) -> Option<PaneOwner> {
        self.panes.values().chain(self.parked.values().flatten()).find(|pane| pane.pane_label == label).cloned()
    }
    pub fn install(&mut self, pane: PaneOwner) -> Option<PaneOwner> {
        self.presented.insert(pane.pane_label.clone());
        let previous = self.panes.insert(pane.window_label.clone(), pane);
        if let Some(previous) = &previous { self.presented.remove(&previous.pane_label); }
        previous
    }
    pub fn is_presented(&self, pane: &str) -> bool { self.presented.contains(pane) }
    pub fn set_presented(&mut self, pane: &str, visible: bool) {
        if visible && self.for_pane(pane).is_some() { self.presented.insert(pane.into()); }
        else { self.presented.remove(pane); }
    }
    pub fn remove(&mut self, window: &str, owner: Option<&str>) -> Option<PaneOwner> {
        // Renderer cleanup never destroys parked sessions; they can still be
        // owned by the conversation that is returning to this window.
        if owner.is_some_and(|owner| self.panes.get(window).is_none_or(|pane| pane.owner_id != owner)) { return None; }
        let removed = self.panes.remove(window);
        if let Some(pane) = &removed { self.presented.remove(&pane.pane_label); }
        removed
    }
    pub fn remove_window(&mut self, window: &str) -> Vec<PaneOwner> {
        let mut panes = self.parked.remove(window).unwrap_or_default();
        if let Some(pane) = self.panes.remove(window) { panes.push(pane); }
        for pane in &panes { self.presented.remove(&pane.pane_label); }
        panes
    }
    pub fn activate(&mut self, window: &str, owner: &str) -> Result<PaneOwner, String> {
        if let Some(active) = self.for_window(window, owner) { return Ok(active); }
        let parked = self.parked.entry(window.into()).or_default();
        let index = parked.iter().position(|pane| pane.owner_id == owner).ok_or("native browser owner is no longer active")?;
        let pane = parked.remove(index);
        if let Some(previous) = self.panes.insert(window.into(), pane.clone()) { self.presented.remove(&previous.pane_label); parked.push(previous); }
        Ok(pane)
    }
    fn can_park(&self, window: &str) -> Result<(), String> {
        if self.panes.contains_key(window) && self.parked.get(window).map_or(0, Vec::len) >= MAX_PARKED_PER_WINDOW {
            return Err("This window already retains eight browser sessions. Close one of those browsers before moving another mission.".into());
        }
        Ok(())
    }
    pub fn transfer_candidate(&self, source: &str, target: &str, owner: &str) -> Result<PaneOwner, String> {
        if source == target { return self.mount(source, owner).ok_or_else(|| "native browser owner is no longer active".into()); }
        if let Some(pane) = self.mount(target, owner) {
            if self.mount(source, owner).is_none() { return Ok(pane); }
            // UUIDs identify mounts, so two different panes with the same UUID
            // cannot be merged into one window without losing their identity.
            return Err("The destination has a different browser with the same owner identity.".into());
        }
        self.can_park(target)?;
        self.mount(source, owner).ok_or_else(|| "The browser changed before this mission could move. Retry the transfer.".into())
    }
    pub fn transfer(&mut self, source: &str, target: &str, owner: &str) -> Result<PaneOwner, String> {
        let mut pane = self.transfer_candidate(source, target, owner)?;
        if pane.window_label == target { return Ok(pane); }
        if self.for_window(source, owner).is_some() {
            self.panes.remove(source);
        } else {
            self.parked.entry(source.into()).or_default().retain(|entry| entry.pane_label != pane.pane_label);
        }
        self.presented.remove(&pane.pane_label);
        if let Some(previous) = self.panes.remove(target) { self.presented.remove(&previous.pane_label); self.parked.entry(target.into()).or_default().push(previous); }
        pane.window_label = target.into();
        self.panes.insert(target.into(), pane.clone());
        Ok(pane)
    }
    pub fn reserve_popup(&mut self, label: String, pane_label: &str, limit: usize) -> bool {
        if self.for_pane(pane_label).is_none() || self.popups.values().filter(|pane| pane.as_str() == pane_label).count() >= limit { return false; }
        self.popups.insert(label, pane_label.into());
        true
    }
    pub fn release_popup(&mut self, label: &str) { self.popups.remove(label); }
    pub fn popups_for(&self, pane_label: &str) -> Vec<String> {
        self.popups.iter().filter(|(_, pane)| pane.as_str() == pane_label).map(|(label, _)| label.clone()).collect()
    }
    pub fn take_popups(&mut self, pane_label: &str) -> Vec<String> {
        let labels = self.popups_for(pane_label);
        for label in &labels { self.popups.remove(label); }
        labels
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pane(window: &str, owner: &str, label: &str) -> PaneOwner { PaneOwner { window_label: window.into(), owner_id: owner.into(), pane_label: label.into() } }
    #[test]
    fn identical_mount_ids_in_two_windows_do_not_share_browser_or_popup_ownership() {
        let mut state = BrowserOwners::default();
        state.install(pane("mission-one", "mount", "pane-1"));
        state.install(pane("mission-two", "mount", "pane-2"));
        assert!(state.reserve_popup("popup-1".into(), "pane-1", 1));
        assert!(!state.reserve_popup("popup-overflow".into(), "pane-1", 1));
        assert!(state.reserve_popup("popup-2".into(), "pane-2", 1));
        assert!(state.transfer("mission-one", "mission-two", "mount").is_err());
        state.remove("mission-one", Some("mount"));
        assert_eq!(state.take_popups("pane-1"), vec!["popup-1"]);
        assert_eq!(state.for_window("mission-two", "mount").unwrap().pane_label, "pane-2");
        assert_eq!(state.take_popups("pane-2"), vec!["popup-2"]);
    }
    #[test]
    fn reparent_preserves_identity_and_routes_callbacks_to_the_new_owner_window() {
        let mut state = BrowserOwners::default();
        state.install(pane("main", "mount", "pane"));
        state.reserve_popup("oauth".into(), "pane", 8);
        state.transfer("main", "mission-one", "mount").unwrap();
        assert_eq!(state.for_pane("pane").unwrap().window_label, "mission-one");
        assert!(state.remove("main", Some("mount")).is_none());
        assert_eq!(state.transfer("main", "mission-one", "mount").unwrap().pane_label, "pane");
        state.transfer("mission-one", "main", "mount").unwrap();
        assert_eq!(state.take_popups("pane"), vec!["oauth"]);
    }
    #[test]
    fn target_is_parked_and_rollback_restores_its_session_without_stale_cleanup() {
        let mut state = BrowserOwners::default();
        state.install(pane("main", "one", "pane-1"));
        state.install(pane("mission", "two", "pane-2"));
        state.reserve_popup("oauth-two".into(), "pane-2", 8);
        state.transfer("main", "mission", "one").unwrap();
        assert_eq!(state.for_window("mission", "one").unwrap().pane_label, "pane-1");
        assert!(state.remove("mission", Some("two")).is_none());
        assert_eq!(state.mount("mission", "two").unwrap().pane_label, "pane-2");
        state.transfer("mission", "main", "one").unwrap();
        assert!(state.for_window("mission", "two").is_none());
        assert!(state.remove("mission", Some("two")).is_none(), "late cleanup cannot destroy the parked candidate before adoption");
        assert_eq!(state.resume_candidate("mission").unwrap().pane_label, "pane-2");
        state.activate("mission", "two").unwrap();
        assert_eq!(state.for_window("mission", "two").unwrap().pane_label, "pane-2");
        assert_eq!(state.popups_for("pane-2"), vec!["oauth-two"]);
        assert!(state.transfer("mission", "main", "one").is_ok());
    }
    #[test]
    fn explicitly_adopting_parked_owner_keeps_both_panes_and_window_cleanup_removes_all() {
        let mut state = BrowserOwners::default();
        state.install(pane("main", "one", "pane-1"));
        state.install(pane("mission", "two", "pane-2"));
        state.transfer("main", "mission", "one").unwrap();
        state.activate("mission", "two").unwrap();
        assert_eq!(state.for_window("mission", "two").unwrap().pane_label, "pane-2");
        assert_eq!(state.mount("mission", "one").unwrap().pane_label, "pane-1");
        let removed = state.remove_window("mission");
        assert_eq!(removed.len(), 2);
        assert!(state.for_pane("pane-1").is_none());
        assert!(state.for_pane("pane-2").is_none());
    }
    #[test]
    fn parking_limit_refuses_transfer_without_dropping_a_session() {
        let mut state = BrowserOwners::default();
        state.install(pane("main", "base", "base-pane"));
        for index in 0..MAX_PARKED_PER_WINDOW {
            let owner = format!("owner-{index}");
            state.install(pane("source", &owner, &format!("pane-{index}")));
            state.transfer("source", "main", &owner).unwrap();
        }
        state.install(pane("source", "overflow", "overflow-pane"));
        assert!(state.transfer("source", "main", "overflow").is_err());
        assert!(state.for_window("source", "overflow").is_some());
        assert!(state.mount("main", "base").is_some());
    }
    #[test]
    fn moving_active_pane_never_presents_a_previous_parked_session_without_adoption() {
        let mut state = BrowserOwners::default();
        state.install(pane("main", "old", "old-pane"));
        state.install(pane("mission", "moving", "moving-pane"));
        state.transfer("mission", "main", "moving").unwrap();
        state.set_presented("moving-pane", true);
        state.transfer("main", "mission", "moving").unwrap();
        assert!(state.for_window("main", "old").is_none());
        assert_eq!(state.resume_candidate("main").unwrap().owner_id, "old");
        assert!(!state.is_presented("old-pane"));
        assert!(!state.is_presented("moving-pane"));
        assert!(state.reserve_popup("late-popup".into(), "old-pane", 8));
        assert!(!state.is_presented("old-pane"), "popup admission does not restore a hidden session");
        state.set_presented("old-pane", true);
        assert!(state.is_presented("old-pane"));
    }
    #[test]
    fn old_close_and_popup_callbacks_cannot_affect_replacement_mounts() {
        let mut state = BrowserOwners::default();
        state.install(pane("main", "old", "pane-old"));
        state.install(pane("main", "new", "pane-new"));
        assert!(state.remove("main", Some("old")).is_none());
        assert!(!state.reserve_popup("late-popup".into(), "pane-old", 8));
        assert_eq!(state.for_window("main", "new").unwrap().pane_label, "pane-new");
    }
}
