/*
 * SinusBot - Loot Distributor
 * !stash based loot deposit + even distribution plugin for TS3.
 *
 * Commands:
 *   !stash                          - start a deposit session (asks for loot items)
 *   !stash create <name>            - create a new stash (you become owner)
 *   !stash join <name>              - join an existing stash
 *   !stash list                     - list all stashes
 *   !stash delete <name>            - delete your own stash (creator only)
 *   !stash clear <name>             - admin only: delete any stash
 *   !stash distribute               - multi-stage distribution flow (depositors only)
 *   !stash undo                     - undo your latest submission in the open deposit session
 *   !stash cancel                   - cancel your active session
 *   !stash help                     - show help
 *
 * Deposit session:
 *   After `!stash` the bot asks which loot you are depositing. Reply with
 *   `<item name> <amount>` or `<amount> <item name>`. Keep entering items,
 *   `undo` removes your latest submission, `cancel` (with confirmation)
 *   or `done` ends the session. After `done` a 60-second grace period
 *   allows `undo` / `cancel` before the deposit becomes final.
 *
 * Distribution:
 *   `!stash distribute` asks you to add participants one by one (by name),
 *   confirm with `done`. Items are split evenly (floor), remainder goes to
 *   depositors first, and the bot prints exactly who has to trade what to whom.
 */

registerPlugin({
    name: 'Loot Distributor',
    version: '1.0.0',
    description: 'Deposit loot into named stashes and distribute it evenly across participants.',
    author: 'FuelClock',
    engine: '>= 0.9.16',
    backends: ['ts3'],
    vars: [
        {
            name: 'allowedGroups',
            type: 'strings',
            title: 'Allowed server group IDs (may deposit/create/join)',
            default: ['23']
        },
        {
            name: 'adminGroups',
            type: 'strings',
            title: 'Admin server group IDs (may use !stash clear, empty = same as allowed groups)',
            default: []
        }
    ]
}, function (sinusbot, config, meta) {
    var engine = require('engine');
    var backend = require('backend');
    var event = require('event');
    var store = require('store');

    var STASH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    var COMMAND = '!stash';

    // ---- OKlib (optional, with fallbacks) ----
    var lib = null;
    try {
        lib = require('OKlib.js');
        if (lib && (!lib.general || !lib.general.checkVersion || !lib.general.checkVersion('1.0.6'))) {
            lib = null;
        }
    } catch (e) {
        lib = null;
    }

    function log(msg) {
        if (lib && lib.general && lib.general.log) {
            lib.general.log(msg, 1);
        } else {
            engine.log('[loot-distributor] ' + msg);
        }
    }

    // ---- Storage ----
    function loadStashes() {
        var s = store.get('stashes');
        if (!s) s = {};
        return s;
    }

    function saveStashes(stashes) {
        store.set('stashes', stashes);
    }

    function loadSessions() {
        var s = store.get('sessions');
        if (!s) s = {};
        return s;
    }

    function saveSessions(sessions) {
        store.set('sessions', sessions);
    }

    // Post-"done" grace period: one final chance to undo/cancel the deposit.
    var GRACE_MS = 60 * 1000;

    function loadGrace() {
        var g = store.get('grace');
        if (!g) g = {};
        return g;
    }

    function saveGrace(grace) {
        store.set('grace', grace);
    }

    function clearGrace(grace, uid) {
        delete grace[uid];
        saveGrace(grace);
    }

    // ---- Helpers ----
    function isIntStr(str) {
        if (lib && lib.helper && lib.helper.isInt) {
            return lib.helper.isInt(str);
        }
        return /^[0-9]+$/.test(String(str));
    }

    function hasGroup(client, groupIds) {
        if (!groupIds || groupIds.length === 0) return false;
        var ids = [];
        for (var i = 0; i < groupIds.length; i++) ids.push(String(groupIds[i]));
        var groups;
        if (lib && lib.serverGroupParseIDs && lib.clientServerGroupsIsMemberOfOne) {
            try {
                return lib.clientServerGroupsIsMemberOfOne(client, lib.serverGroupParseGroups(ids));
            } catch (e) { /* fall through to manual check */ }
        }
        groups = client.getServerGroups();
        if (!groups) return false;
        for (var j = 0; j < groups.length; j++) {
            var gid = String(groups[j].id());
            for (var k = 0; k < ids.length; k++) {
                if (gid === ids[k]) return true;
            }
        }
        return false;
    }

    function isAllowed(client) {
        var allowed = (config && config.allowedGroups && config.allowedGroups.length) ? config.allowedGroups : ['23'];
        return hasGroup(client, allowed);
    }

    function isAdmin(client) {
        var admins = (config && config.adminGroups && config.adminGroups.length) ? config.adminGroups : null;
        if (!admins) return isAllowed(client); // empty admin list => allowed groups count as admin
        return hasGroup(client, admins);
    }

    function findOnlineClient(name) {
        var clients = (typeof backend.getClients === 'function') ? backend.getClients() : backend.clients;
        if (!clients) return null;
        var lower = String(name).toLowerCase();
        for (var i = 0; i < clients.length; i++) {
            if (String(clients[i].name()).toLowerCase() === lower) return clients[i];
        }
        return null;
    }

    function clientUid(client) {
        try { return String(client.uid()); } catch (e) { return String(client.id()); }
    }

    function clientName(client) {
        try { return String(client.name()); } catch (e) { return '?'; }
    }

    function now() {
        return Date.now();
    }

    // Purge stashes older than 7 days
    function purgeOldStashes() {
        var stashes = loadStashes();
        var changed = false;
        var cutoff = now() - STASH_MAX_AGE_MS;
        for (var key in stashes) {
            if (stashes.hasOwnProperty(key)) {
                var st = stashes[key];
                if (!st.createdAt || st.createdAt < cutoff) {
                    delete stashes[key];
                    changed = true;
                    log('auto-deleted expired stash "' + key + '"');
                }
            }
        }
        if (changed) saveStashes(stashes);
        // drop sessions referencing deleted stashes
        var sessions = loadSessions();
        var sChanged = false;
        for (var uid in sessions) {
            if (sessions.hasOwnProperty(uid)) {
                var sess = sessions[uid];
                if (sess.stash && !stashes[sess.stash]) {
                    delete sessions[uid];
                    sChanged = true;
                }
            }
        }
        if (sChanged) saveSessions(sessions);
    }

    // Parse "<item> <amount>" or "<amount> <item>"
    // Returns { name: string, amount: int } or null
    function parseItemLine(text) {
        var t = String(text).trim().replace(/\s+/g, ' ');
        if (!t) return null;
        var parts = t.split(' ');
        var first = parts[0], last = parts[parts.length - 1];
        var amount, nameWords;
        if (isIntStr(first)) {
            amount = parseInt(first, 10);
            nameWords = parts.slice(1);
        } else if (isIntStr(last)) {
            amount = parseInt(last, 10);
            nameWords = parts.slice(0, parts.length - 1);
        } else {
            return null;
        }
        var name = nameWords.join(' ').trim();
        if (!name || amount <= 0) return null;
        return { name: name, amount: amount };
    }

    function addItem(stash, uid, uname, itemName, amount) {
        // duplicate depositor names are not allowed in a stash
        var l = String(uname).toLowerCase();
        for (var du in stash.deposits) {
            if (!stash.deposits.hasOwnProperty(du)) continue;
            if (du !== uid && String(stash.deposits[du].name).toLowerCase() === l) {
                return null;
            }
        }
        var key = itemName.toLowerCase();
        if (!stash.items[key]) stash.items[key] = { name: itemName, amount: 0 };
        stash.items[key].name = itemName; // keep newest casing
        stash.items[key].amount += amount;
        if (!stash.deposits[uid]) stash.deposits[uid] = { name: uname, items: {} };
        stash.deposits[uid].name = uname;
        if (!stash.deposits[uid].items[key]) stash.deposits[uid].items[key] = 0;
        stash.deposits[uid].items[key] += amount;
        return key;
    }

    function removeItem(stash, uid, itemKey, amount) {
        var entry = stash.items[itemKey];
        if (!entry) return false;
        entry.amount -= amount;
        if (entry.amount <= 0) delete stash.items[itemKey];
        var dep = stash.deposits[uid];
        if (dep && dep.items[itemKey]) {
            dep.items[itemKey] -= amount;
            if (dep.items[itemKey] <= 0) delete dep.items[itemKey];
            var empty = true, k;
            for (k in dep.items) { if (dep.items.hasOwnProperty(k)) { empty = false; break; } }
            if (empty) delete stash.deposits[uid];
        }
        return true;
    }

    function stashSummary(stash) {
        var lines = [], total = 0, k;
        for (k in stash.items) {
            if (stash.items.hasOwnProperty(k)) {
                lines.push('- ' + stash.items[k].name + ': ' + stash.items[k].amount);
                total += stash.items[k].amount;
            }
        }
        if (lines.length === 0) return 'Stash "' + stash.name + '" is empty.';
        return 'Stash "' + stash.name + '" (' + total + ' items total):\n' + lines.join('\n');
    }

    // ---- Chat output helper ----
    function reply(client, msg) {
        try {
            client.chat(msg);
        } catch (e) {
            log('chat failed: ' + e);
        }
    }

    // ---- Command handling ----
    function cmdHelp(client) {
        reply(client, [
            'Loot Distributor commands:',
            '!stash - start depositing loot into your stash',
            '!stash create <name> - create a stash',
            '!stash join <name> - join a stash',
            '!stash list - list stashes',
            '!stash delete <name> - delete your own stash',
            '!stash clear <name> - admin: delete any stash',
            '!stash distribute - distribute a stash evenly (depositors)',
            '!stash undo / cancel - while in a session, or within 60s after "done"',
        ].join('\n'));
    }

    function cmdCreate(client, name) {
        var uid = clientUid(client);
        var uname = clientName(client);
        if (!name) { reply(client, 'Usage: !stash create <name>'); return; }
        var stashes = loadStashes();
        var key = name.toLowerCase();
        if (stashes[key]) { reply(client, 'A stash with that name already exists. Pick another name.'); return; }
        stashes[key] = {
            name: name,
            createdBy: uid,
            createdByName: uname,
            createdAt: now(),
            items: {},
            deposits: {},
            members: [uid]
        };
        saveStashes(stashes);
        reply(client, 'Stash "' + name + '" created. You are the owner. Type !stash to deposit loot into it.');
        log(uname + ' created stash "' + name + '"');
    }

    function cmdJoin(client, name) {
        var uid = clientUid(client);
        var uname = clientName(client);
        if (!name) { reply(client, 'Usage: !stash join <name>'); return; }
        var stashes = loadStashes();
        var key = name.toLowerCase();
        if (!stashes[key]) { reply(client, 'No stash named "' + name + '" exists. Use !stash list to see stashes.'); return; }
        var members = stashes[key].members || [];
        var found = false;
        for (var i = 0; i < members.length; i++) if (members[i] === uid) found = true;
        if (!found) members.push(uid);
        stashes[key].members = members;
        saveStashes(stashes);
        reply(client, 'You joined stash "' + stashes[key].name + '". Type !stash to deposit loot into it.');
    }

    function cmdList(client) {
        var stashes = loadStashes();
        var keys = [];
        for (var k in stashes) if (stashes.hasOwnProperty(k)) keys.push(k);
        if (keys.length === 0) { reply(client, 'No stashes exist yet. Create one with !stash create <name>.'); return; }
        keys.sort();
        var lines = ['Existing stashes:'];
        for (var i = 0; i < keys.length; i++) {
            var st = stashes[keys[i]];
            var count = 0, ik;
            for (ik in st.items) if (st.items.hasOwnProperty(ik)) count += st.items[ik].amount;
            lines.push('- ' + st.name + ' (owner: ' + st.createdByName + ', ' + count + ' items)');
        }
        reply(client, lines.join('\n'));
    }

    function cmdDelete(client, name, admin) {
        var uid = clientUid(client);
        if (!name) { reply(client, 'Usage: !stash delete <name>'); return; }
        var stashes = loadStashes();
        var key = name.toLowerCase();
        if (!stashes[key]) { reply(client, 'No stash named "' + name + '" exists.'); return; }
        if (!admin && stashes[key].createdBy !== uid) {
            reply(client, 'You can only delete stashes you created.');
            return;
        }
        delete stashes[key];
        saveStashes(stashes);
        // kill sessions on that stash
        var sessions = loadSessions();
        for (var suid in sessions) {
            if (sessions.hasOwnProperty(suid) && sessions[suid].stash === key) delete sessions[suid];
        }
        saveSessions(sessions);
        reply(client, 'Stash "' + name + '" deleted.');
        log(clientName(client) + ' deleted stash "' + name + '"');
    }

    function myStashOf(uid) {
        var stashes = loadStashes();
        for (var key in stashes) {
            if (stashes.hasOwnProperty(key)) {
                var members = stashes[key].members || [];
                for (var i = 0; i < members.length; i++) {
                    if (members[i] === uid) return stashes[key];
                }
            }
        }
        return null;
    }

    // ---- Deposit session ----
    function startDeposit(client) {
        var uid = clientUid(client);
        var stash = myStashOf(uid);
        if (!stash) {
            reply(client, 'You are not in a stash yet. Create one with !stash create <name> or join one with !stash join <name>.');
            return;
        }
        var sessions = loadSessions();
        sessions[uid] = { type: 'deposit', stash: stash.name.toLowerCase(), items: [] };
        saveSessions(sessions);
        reply(client, 'Which loot are you depositing into "' + stash.name + '"?\nEnter items as "<item name> <amount>" or "<amount> <item name>".\nType "undo" to remove your last item, "cancel" to abort stashing, or "done" to finish.');
    }

    function handleDepositInput(client, text) {
        var uid = clientUid(client);
        var uname = clientName(client);
        var sessions = loadSessions();
        var sess = sessions[uid];
        var stashes = loadStashes();
        var stash = stashes[sess.stash];
        if (!stash) {
            delete sessions[uid];
            saveSessions(sessions);
            reply(client, 'Your stash no longer exists. Deposit session cancelled.');
            return;
        }
        var lower = text.toLowerCase().trim();
        if (sess.confirmCancel) {
            if (lower === 'yes') {
                var undone = 0;
                if (sess.items && sess.items.length) {
                    for (var i = sess.items.length - 1; i >= 0; i--) {
                        if (removeItem(stash, uid, sess.items[i].key, sess.items[i].amount)) undone++;
                    }
                }
                delete sessions[uid];
                saveSessions(sessions);
                saveStashes(stashes);
                reply(client, 'Cancelled stashing. Removed ' + undone + ' item' + (undone === 1 ? '' : 's') + ' from this session.\n' + stashSummary(stash));
            } else if (lower === 'no') {
                delete sessions[uid].confirmCancel;
                saveSessions(sessions);
                reply(client, 'Continuing. Enter the next item, "undo" to undo submission or "done" to finish stashing items.');
            } else {
                reply(client, 'Are you sure you want to cancel stashing? This will remove all items that haven\'t had their submission confirmed yet with "done". Reply yes or no.');
            }
            return;
        }
        if (lower === 'cancel') {
            if (!sess.items || !sess.items.length) {
                delete sessions[uid];
                saveSessions(sessions);
                reply(client, 'Deposit session cancelled. Nothing was deposited.');
                return;
            }
            sess.confirmCancel = true;
            saveSessions(sessions);
            reply(client, 'Are you sure you want to cancel stashing? This will remove all items that haven\'t had their submission confirmed yet with "done". Reply yes or no.');
            return;
        }
        if (lower === 'done') {
            var grace = loadGrace();
            if (sess.items && sess.items.length) {
                grace[uid] = { stash: sess.stash, items: sess.items, until: now() + GRACE_MS };
                saveGrace(grace);
                delete sessions[uid];
                saveSessions(sessions);
                saveStashes(stashes);
                reply(client, 'Deposit confirmed. You have 60 seconds to type "undo" to remove your last item or "cancel" to remove all items from this session - after that the deposit is final.\n' + stashSummary(stash));
            } else {
                delete sessions[uid];
                saveSessions(sessions);
                saveStashes(stashes);
                reply(client, 'Deposit session ended.\n' + stashSummary(stash));
            }
            return;
        }
        if (lower === 'undo') {
            if (!sess.items || !sess.items.length) {
                reply(client, 'Nothing to undo in this session.');
                return;
            }
            var last = sess.items[sess.items.length - 1];
            if (removeItem(stash, uid, last.key, last.amount)) {
                sess.items.pop();
                if (!sess.items.length) delete sessions[uid].items;
                saveSessions(sessions);
                saveStashes(stashes);
                reply(client, 'Removed ' + last.amount + 'x "' + last.name + '" from the stash. Enter the next item, "undo" to undo submission or "done" to finish stashing items.');
            } else {
                reply(client, 'Could not undo that entry.');
            }
            return;
        }
        var parsed = parseItemLine(text);
        if (!parsed) {
            reply(client, 'Could not read that. Use "<item name> <amount>" or "<amount> <item name>", or "done" to finish.');
            return;
        }
        var key = addItem(stash, uid, uname, parsed.name, parsed.amount);
        if (!key) {
            reply(client, 'Another account with the nickname "' + uname + '" already deposited in this stash. Duplicate names are not allowed.');
            return;
        }
        sessions[uid].last = { key: key, amount: parsed.amount, name: parsed.name };
        if (!sessions[uid].items) sessions[uid].items = [];
        sessions[uid].items.push(sessions[uid].last);
        saveSessions(sessions);
        saveStashes(stashes);
        reply(client, parsed.amount + 'x "' + parsed.name + '" added to loot stash. Enter the next item, "undo" to undo submission or "done" to finish stashing items.');
    }

    // ---- Post-"done" grace period ----
    // 60s window after "done" during which "undo"/"cancel" still work.
    // Starting a new stashing session is NOT blocked: an active session
    // always takes priority and the grace record simply expires on its own.
    function handleGrace(client, text) {
        var uid = clientUid(client);
        var grace = loadGrace();
        var g = grace[uid];
        if (!g) return false;
        var stashes = loadStashes();
        var stash = stashes[g.stash];
        var lower = String(text).toLowerCase().trim();
        if (!stash || now() >= g.until) {
            clearGrace(grace, uid);
            if (stash && lower !== 'undo' && lower !== 'cancel') return false;
            reply(client, 'The grace period is over. Your deposit is final.');
            return true;
        }
        if (g.confirmCancel) {
            if (lower === 'yes') {
                var removed = 0;
                for (var i = g.items.length - 1; i >= 0; i--) {
                    if (removeItem(stash, uid, g.items[i].key, g.items[i].amount)) removed++;
                }
                clearGrace(grace, uid);
                saveStashes(stashes);
                reply(client, 'Cancelled stashing. Removed ' + removed + ' item' + (removed === 1 ? '' : 's') + ' from this session.\n' + stashSummary(stash));
            } else if (lower === 'no') {
                delete g.confirmCancel;
                saveGrace(grace);
                reply(client, 'Continuing. Type "undo" to remove your last item or "cancel" to remove all items from this session.');
            } else {
                reply(client, 'Are you sure you want to cancel stashing? This will remove all items that haven\'t had their submission confirmed yet with "done". Reply yes or no.');
            }
            return true;
        }
        if (lower === 'cancel') {
            if (g.items && g.items.length) {
                g.confirmCancel = true;
                saveGrace(grace);
                reply(client, 'Are you sure you want to cancel stashing? This will remove all items that haven\'t had their submission confirmed yet with "done". Reply yes or no.');
            } else {
                clearGrace(grace, uid);
                reply(client, 'Nothing to remove. Your deposit is final.');
            }
            return true;
        }
        if (lower === 'undo') {
            if (!g.items || !g.items.length) {
                clearGrace(grace, uid);
                reply(client, 'Nothing to undo. Your deposit is final.');
                return true;
            }
            var last = g.items[g.items.length - 1];
            if (removeItem(stash, uid, last.key, last.amount)) {
                g.items.pop();
                if (!g.items.length) {
                    clearGrace(grace, uid);
                    reply(client, 'Removed ' + last.amount + 'x "' + last.name + '" from the stash. That was all - your deposit is final.\n' + stashSummary(stash));
                } else {
                    saveGrace(grace);
                    reply(client, 'Removed ' + last.amount + 'x "' + last.name + '" from the stash. Type "undo" to remove another item or "cancel" to remove all.');
                }
            } else {
                reply(client, 'Could not undo that entry.');
            }
            saveStashes(stashes);
            return true;
        }
        return false;
    }

    // ---- Distribution ----
    function startDistribute(client) {
        var uid = clientUid(client);
        var stash = myStashOf(uid);
        if (!stash) {
            reply(client, 'You are not in a stash. Use !stash create <name> or !stash join <name> first.');
            return;
        }
        if (!stash.deposits[uid]) {
            reply(client, 'Only active depositors of a stash can start a distribution. Deposit something with !stash first.');
            return;
        }
        var empty = true, k;
        for (k in stash.items) { if (stash.items.hasOwnProperty(k)) { empty = false; break; } }
        if (empty) {
            reply(client, 'Stash "' + stash.name + '" is empty. Nothing to distribute.');
            return;
        }
        var sessions = loadSessions();
        // Pre-fill participants with all stash depositors (in deposit order)
        var participants = [];
        for (var du in stash.deposits) {
            if (stash.deposits.hasOwnProperty(du)) participants.push(stash.deposits[du].name);
        }
        sessions[uid] = { type: 'distribute', stash: stash.name.toLowerCase(), participants: participants };
        saveSessions(sessions);
        reply(client, 'Distributing "' + stash.name + '".\nParticipants (depositors): ' + participants.join(', ') + '\nType another participant name to add them (exact name as submitted), or "done" to calculate.');
    }

    // Add a participant exactly as submitted; duplicates (case-insensitive) are rejected.
    function participantExists(participants, tname) {
        var lower = String(tname).toLowerCase();
        for (var i = 0; i < participants.length; i++) {
            if (String(participants[i]).toLowerCase() === lower) return true;
        }
        return false;
    }

    function handleDistributeInput(client, text) {
        var uid = clientUid(client);
        var sessions = loadSessions();
        var sess = sessions[uid];
        var lower = text.toLowerCase().trim();
        if (lower === 'cancel') {
            delete sessions[uid];
            saveSessions(sessions);
            reply(client, 'Distribution cancelled.');
            return;
        }
        if (lower === 'done') {
            var stashes = loadStashes();
            var stash = stashes[sess.stash];
            delete sessions[uid];
            saveSessions(sessions);
            if (!stash) { reply(client, 'Your stash no longer exists.'); return; }
            saveStashes(stashes);
            reply(client, calculateDistribution(stash, sess.participants));
            return;
        }
        var tname = text.trim();
        if (participantExists(sess.participants, tname)) {
            reply(client, tname + ' is already a participant. Add another or "done" to calculate.');
            return;
        }
        sess.participants.push(tname);
        saveSessions(sessions);
        reply(client, 'Added ' + tname + ' (' + sess.participants.length + ' participants). Add another name, or "done" to calculate.');
    }

    // Even distribution: floor(N/X) each, remainder to depositors first.
    // Participants are the exact strings submitted (depositors pre-filled).
    // Depositors keep their own deposited items; trades only happen between
    // different participants.
    function calculateDistribution(stash, participants) {
        var X = participants.length;
        if (X === 0) return 'No participants. Distribution cancelled.';

        function lower(s) { return String(s).toLowerCase(); }

        // deposited amount of an item for a participant name
        function depositedOf(name, itemKey) {
            var l = lower(name);
            var total = 0;
            for (var du in stash.deposits) {
                if (!stash.deposits.hasOwnProperty(du)) continue;
                if (lower(stash.deposits[du].name) === l) {
                    total += stash.deposits[du].items[itemKey] || 0;
                }
            }
            return total;
        }

        // participant names that deposited anything at all (for remainder preference)
        var isDepositor = {};
        for (var pi = 0; pi < participants.length; pi++) {
            for (var ik in stash.items) {
                if (stash.items.hasOwnProperty(ik) && depositedOf(participants[pi], ik) > 0) {
                    isDepositor[lower(participants[pi])] = true;
                    break;
                }
            }
        }

        var lines = ['=== Distribution of "' + stash.name + '" ==='];
        var gives = {}; // depositorNameLower -> [{ to: name, item: name, amount: n }]
        var keeps = []; // "X keeps their own Nx <item>"
        var anyItem = false;

        for (var itemKey in stash.items) {
            if (!stash.items.hasOwnProperty(itemKey)) continue;
            anyItem = true;
            var item = stash.items[itemKey];
            var N = item.amount;
            var base = Math.floor(N / X);
            var rem = N % X;

            // Depositors first (deposit order), then others (input order)
            var order = [];
            for (var du0 in stash.deposits) {
                if (!stash.deposits.hasOwnProperty(du0)) continue;
                var dName = stash.deposits[du0].name;
                if (participantExists(participants, dName) && isDepositor[lower(dName)]) order.push(dName);
            }
            for (var j = 0; j < participants.length; j++) {
                if (!isDepositor[lower(participants[j])]) order.push(participants[j]);
            }

            var share = {}; // lower name -> amount received of this item
            for (var p = 0; p < order.length; p++) {
                var extra = (p < rem) ? 1 : 0;
                share[lower(order[p])] = base + extra;
            }

            lines.push('-- ' + item.name + ' (' + N + ' total, ' + X + ' participants) --');
            for (var r = 0; r < order.length; r++) {
                var nm = order[r];
                lines.push(nm + ' receives ' + share[lower(nm)] + 'x ' + item.name);
            }

            // trade instructions per depositor
            for (var du1 in stash.deposits) {
                if (!stash.deposits.hasOwnProperty(du1)) continue;
                var dName1 = stash.deposits[du1].name;
                var dKey = lower(dName1);
                if (!participantExists(participants, dName1)) continue; // depositor not participating
                var gave = stash.deposits[du1].items[itemKey] || 0;
                var gets = share[dKey] || 0;
                if (gave > gets) {
                    var owed = gave - gets;
                    // give surplus to OTHER participants who need more than they deposited
                    for (var t = 0; t < order.length && owed > 0; t++) {
                        var rec = order[t];
                        if (lower(rec) === dKey) continue; // never trade to yourself - keep instead
                        var recNeed = (share[lower(rec)] || 0) - depositedOf(rec, itemKey);
                        if (recNeed > 0) {
                            var give = Math.min(owed, recNeed);
                            if (!gives[dKey]) gives[dKey] = [];
                            gives[dKey].push({ from: dName1, to: rec, item: item.name, amount: give });
                            owed -= give;
                        }
                    }
                    // leftover surplus: give to first other participants in order
                    for (var t2 = 0; t2 < order.length && owed > 0; t2++) {
                        var rec2 = order[t2];
                        if (lower(rec2) === dKey) continue;
                        var give2 = Math.min(owed, share[lower(rec2)] || 0);
                        if (give2 > 0) {
                            if (!gives[dKey]) gives[dKey] = [];
                            gives[dKey].push({ from: dName1, to: rec2, item: item.name, amount: give2 });
                            owed -= give2;
                        }
                    }
                } else if (gave > 0) {
                    keeps.push(dName1 + ' keeps their ' + gave + 'x ' + item.name + ' (share: ' + gets + 'x)');
                }
            }
        }

        if (!anyItem) return 'Stash "' + stash.name + '" is empty. Nothing to distribute.';

        var tradeLines = [];
        for (var gk in gives) {
            if (!gives.hasOwnProperty(gk)) continue;
            for (var g = 0; g < gives[gk].length; g++) {
                tradeLines.push(gives[gk][g].from + ' trades ' + gives[gk][g].amount + 'x ' + gives[gk][g].item + ' to ' + gives[gk][g].to);
            }
        }
        if (tradeLines.length > 0) {
            lines.push('--- Trades required ---');
            lines = lines.concat(tradeLines);
        } else {
            lines.push('No trades required.');
        }
        if (keeps.length > 0) {
            lines.push('--- Keep ---');
            lines = lines.concat(keeps);
        }
        return lines.join('\n');
    }

    // ---- Main command router ----
    function handleCommand(client, msg) {
        var text = msg.substring(COMMAND.length).trim();
        var parts = text.length ? text.split(/\s+/) : [];
        var sub = parts.length ? parts[0].toLowerCase() : '';

        if (!isAllowed(client)) {
            reply(client, 'You do not have permission to use the loot stash.');
            return;
        }

        if (sub === '') {
            startDeposit(client);
        } else if (sub === 'help') {
            cmdHelp(client);
        } else if (sub === 'create') {
            cmdCreate(client, parts.slice(1).join(' ').trim());
        } else if (sub === 'join') {
            cmdJoin(client, parts.slice(1).join(' ').trim());
        } else if (sub === 'list') {
            cmdList(client);
        } else if (sub === 'delete' || sub === 'remove') {
            cmdDelete(client, parts.slice(1).join(' ').trim(), false);
        } else if (sub === 'clear') {
            if (!isAdmin(client)) {
                reply(client, 'Only admins can use !stash clear.');
                return;
            }
            cmdDelete(client, parts.slice(1).join(' ').trim(), true);
        } else if (sub === 'distribute') {
            startDistribute(client);
        } else if (sub === 'undo' || sub === 'cancel') {
            var sessions = loadSessions();
            var uid = clientUid(client);
            if (!sessions[uid]) {
                // fall back to the post-"done" grace period
                if (handleGrace(client, sub)) return;
                reply(client, 'You have no active session.');
                return;
            }
            // route through the session handlers as if user typed it
            if (sessions[uid].type === 'deposit') handleDepositInput(client, sub);
            else handleDistributeInput(client, sub);
        } else {
            reply(client, 'Unknown subcommand. Use !stash, !stash create <name>, !stash join <name>, !stash list, !stash delete <name>, !stash distribute or !stash help.');
        }
    }

    // ---- Events ----
    event.on('chat', function (ev) {
        if (!backend.isConnected()) return;
        var client = ev.client;
        if (!client || client.isSelf()) return;
        var msg = String(ev.text || '');
        var trimmed = msg.trim();
        if (!trimmed) return;

        var lower = trimmed.toLowerCase();
        var uid = clientUid(client);

        // Commands always take priority
        if (lower === COMMAND || lower.indexOf(COMMAND + ' ') === 0) {
            handleCommand(client, trimmed);
            return;
        }

        // Active sessions swallow plain chat
        var sessions = loadSessions();
        var sess = sessions[uid];
        if (sess) {
            if (sess.type === 'deposit') {
                handleDepositInput(client, trimmed);
            } else if (sess.type === 'distribute') {
                handleDistributeInput(client, trimmed);
            }
            return;
        }

        // post-"done" grace period: only undo/cancel (and yes/no during
        // cancel confirmation) are handled; all other chat is ignored
        var grace = loadGrace();
        if (grace[uid]) {
            var gl = lower;
            var g = grace[uid];
            if (g.confirmCancel || gl === 'undo' || gl === 'cancel') {
                handleGrace(client, trimmed);
            }
        }
    });

    event.on('load', function () {
        log('Loot Distributor v' + meta.version + ' loaded');
        purgeOldStashes();
        setInterval(purgeOldStashes, 60 * 60 * 1000); // hourly cleanup
    });

    log('Loot Distributor registered');
});
