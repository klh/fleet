function i(e,r=Date.now()){return!!e&&Number.isFinite(e.observedAt)&&Number.isFinite(e.expiresAt)&&e.observedAt<=r+5000&&e.expiresAt>e.observedAt&&r<e.expiresAt}export{i};
