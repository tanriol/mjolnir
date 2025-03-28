/*
Copyright 2019-2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { extractRequestError, LogService, MatrixClient } from "matrix-bot-sdk";
import { EventEmitter } from "events";
import { ListRule, RECOMMENDATION_BAN } from "./ListRule";

export const RULE_USER = "m.policy.rule.user";
export const RULE_ROOM = "m.policy.rule.room";
export const RULE_SERVER = "m.policy.rule.server";

// README! The order here matters for determining whether a type is obsolete, most recent should be first.
// These are the current and historical types for each type of rule which were used while MSC2313 was being developed
// and were left as an artifact for some time afterwards.
// Most rules (as of writing) will have the prefix `m.room.rule.*` as this has been in use for roughly 2 years.
export const USER_RULE_TYPES = [RULE_USER, "m.room.rule.user", "org.matrix.mjolnir.rule.user"];
export const ROOM_RULE_TYPES = [RULE_ROOM, "m.room.rule.room", "org.matrix.mjolnir.rule.room"];
export const SERVER_RULE_TYPES = [RULE_SERVER, "m.room.rule.server", "org.matrix.mjolnir.rule.server"];
export const ALL_RULE_TYPES = [...USER_RULE_TYPES, ...ROOM_RULE_TYPES, ...SERVER_RULE_TYPES];

export const SHORTCODE_EVENT_TYPE = "org.matrix.mjolnir.shortcode";

export function ruleTypeToStable(rule: string, unstable = true): string|null {
    if (USER_RULE_TYPES.includes(rule)) return unstable ? USER_RULE_TYPES[USER_RULE_TYPES.length - 1] : RULE_USER;
    if (ROOM_RULE_TYPES.includes(rule)) return unstable ? ROOM_RULE_TYPES[ROOM_RULE_TYPES.length - 1] : RULE_ROOM;
    if (SERVER_RULE_TYPES.includes(rule)) return unstable ? SERVER_RULE_TYPES[SERVER_RULE_TYPES.length - 1] : RULE_SERVER;
    return null;
}

export enum ChangeType {
    Added    = "ADDED",
    Removed  = "REMOVED",
    Modified = "MODIFIED"
}

export interface ListRuleChange {
    readonly changeType: ChangeType,
    /**
     * State event that caused the change.
     * If the rule was redacted, this will be the redacted version of the event.
     */
    readonly event: any,
    /**
     * The sender that caused the change.
     * The original event sender unless the change is because `event` was redacted. When the change is `event` being redacted
     * this will be the user who caused the redaction.
     */
    readonly sender: string,
    /**
     * The current rule represented by the event.
     * If the rule has been removed, then this will show what the rule was.
     */
    readonly rule: ListRule,
    /**
     * The previous state that has been changed. Only (and always) provided when the change type is `ChangeType.Removed` or `Modified`.
     * This will be a copy of the same event as `event` when a redaction has occurred and this will show its unredacted state.
     */
    readonly previousState?: any,
}

declare interface BanList {
    // BanList.update is emitted when the BanList has pulled new rules from Matrix and informs listeners of any changes.
    on(event: 'BanList.update', listener: (list: BanList, changes: ListRuleChange[]) => void): this
    emit(event: 'BanList.update', list: BanList, changes: ListRuleChange[]): boolean
    // BanList.batch is emitted when the BanList has created a batch from the events provided by `updateForEvent`.
    on(event: 'BanList.batch', listener: (list: BanList) => void): this
    emit(event: 'BanList.batch', list: BanList): boolean
}

/**
 * The BanList caches all of the rules that are active in a policy room so Mjolnir can refer to when applying bans etc.
 * This cannot be used to update events in the modeled room, it is a readonly model of the policy room.
 */
class BanList extends EventEmitter {
    private shortcode: string|null = null;
    // A map of state events indexed first by state type and then state keys.
    private state: Map<string, Map<string, any>> = new Map();
    // Batches new events from sync together before starting the process to update the list.
    private readonly batcher: UpdateBatcher;

    /**
     * Construct a BanList, does not synchronize with the room.
     * @param roomId The id of the policy room, i.e. a room containing MSC2313 policies.
     * @param roomRef A sharable/clickable matrix URL that refers to the room.
     * @param client A matrix client that is used to read the state of the room when `updateList` is called.
     */
    constructor(public readonly roomId: string, public readonly roomRef: string, private client: MatrixClient) {
        super();
        this.batcher = new UpdateBatcher(this);
    }

    /**
     * The code that can be used to refer to this banlist in Mjolnir commands.
     */
    public get listShortcode(): string {
        return this.shortcode || '';
    }

    /**
     * Lookup the current rules cached for the list.
     * @param stateType The event type e.g. m.policy.rule.user.
     * @param stateKey The state key e.g. rule:@bad:matrix.org
     * @returns A state event if present or null.
     */
    private getState(stateType: string, stateKey: string) {
        return this.state.get(stateType)?.get(stateKey);
    }

    /**
     * Store this state event as part of the active room state for this BanList (used to cache rules).
     * The state type should be normalised if it is obsolete e.g. m.room.rule.user should be stored as m.policy.rule.user.
     * @param stateType The event type e.g. m.room.policy.user.
     * @param stateKey The state key e.g. rule:@bad:matrix.org
     * @param event A state event to store.
     */
    private setState(stateType: string, stateKey: string, event: any): void {
        let typeTable = this.state.get(stateType);
        if (typeTable) {
            typeTable.set(stateKey, event);
        } else {
            this.state.set(stateType, new Map().set(stateKey, event));
        }
    }

    /**
     * Return all the active rules of a given kind.
     * @param kind e.g. RULE_SERVER (m.policy.rule.server). Rule types are always normalised when they are interned into the BanList.
     * @returns The active ListRules for the ban list of that kind.
     */
    private rulesOfKind(kind: string): ListRule[] {
        const rules: ListRule[] = []
        const stateKeyMap = this.state.get(kind);
        if (stateKeyMap) {
            for (const event of stateKeyMap.values()) {
                const rule = event?.unsigned?.rule;
                // README! If you are refactoring this and/or introducing a mechanism to return the list of rules,
                // please make sure that you *only* return rules with `m.ban` or create a different method
                // (we don't want to accidentally ban entities).
                if (rule && rule.kind === kind && rule.recommendation === RECOMMENDATION_BAN) {
                    rules.push(rule);
                }
            }
        }
        return rules;
    }

    public set listShortcode(newShortcode: string) {
        const currentShortcode = this.shortcode;
        this.shortcode = newShortcode;
        this.client.sendStateEvent(this.roomId, SHORTCODE_EVENT_TYPE, '', {shortcode: this.shortcode}).catch(err => {
            LogService.error("BanList", extractRequestError(err));
            if (this.shortcode === newShortcode) this.shortcode = currentShortcode;
        });
    }

    public get serverRules(): ListRule[] {
        return this.rulesOfKind(RULE_SERVER);
    }

    public get userRules(): ListRule[] {
        return this.rulesOfKind(RULE_USER);
    }

    public get roomRules(): ListRule[] {
        return this.rulesOfKind(RULE_ROOM);
    }

    public get allRules(): ListRule[] {
        return [...this.serverRules, ...this.userRules, ...this.roomRules];
    }

    /**
     * Remove all rules in the banList for this entity that have the same state key (as when we ban them)
     * by searching for rules that have legacy state types.
     * @param ruleType The normalized (most recent) type for this rule e.g. `RULE_USER`.
     * @param entity The entity to unban from this list.
     * @returns true if any rules were removed and the entity was unbanned, otherwise false because there were no rules.
     */
    public async unbanEntity(ruleType: string, entity: string): Promise<boolean> {
        const stateKey = `rule:${entity}`;
        let typesToCheck = [ruleType];
        switch (ruleType) {
            case RULE_USER:
                typesToCheck = USER_RULE_TYPES;
                break;
            case RULE_SERVER:
                typesToCheck = SERVER_RULE_TYPES;
                break;
            case RULE_ROOM:
                typesToCheck = ROOM_RULE_TYPES;
                break;
        }
        // We can't cheat and check our state cache because we normalize the event types to the most recent version.
        const typesToRemove = (await Promise.all(
            typesToCheck.map(stateType => this.client.getRoomStateEvent(this.roomId, stateType, stateKey)
                .then(_ => stateType) // We need the state type as getRoomState only returns the content, not the top level.
                .catch(e => e.statusCode === 404 ? null : Promise.reject(e))))
        ).filter(e => e); // remove nulls. I don't know why TS still thinks there can be nulls after this??
        if (typesToRemove.length === 0) {
            return false;
        }
        await Promise.all(typesToRemove.map(stateType => this.client.sendStateEvent(this.roomId, stateType!, stateKey, {})));
        return true;
    }

    /**
     * Synchronise the model with the room representing the ban list by reading the current state of the room
     * and updating the model to reflect the room.
     * @returns A description of any rules that were added, modified or removed from the list as a result of this update.
     */
    public async updateList(): Promise<ListRuleChange[]> {
        let changes: ListRuleChange[] = [];

        const state = await this.client.getRoomState(this.roomId);
        for (const event of state) {
            if (event['state_key'] === '' && event['type'] === SHORTCODE_EVENT_TYPE) {
                this.shortcode = (event['content'] || {})['shortcode'] || null;
                continue;
            }

            if (event['state_key'] === '' || !ALL_RULE_TYPES.includes(event['type'])) {
                continue;
            }

            let kind: string|null = null;
            if (USER_RULE_TYPES.includes(event['type'])) {
                kind = RULE_USER;
            } else if (ROOM_RULE_TYPES.includes(event['type'])) {
                kind = RULE_ROOM;
            } else if (SERVER_RULE_TYPES.includes(event['type'])) {
                kind = RULE_SERVER;
            } else {
                continue; // invalid/unknown
            }

            const previousState = this.getState(kind, event['state_key']);

            // Now we need to figure out if the current event is of an obsolete type
            // (e.g. org.matrix.mjolnir.rule.user) when compared to the previousState (which might be m.policy.rule.user).
            // We do not want to overwrite a rule of a newer type with an older type even if the event itself is supposedly more recent
            // as it may be someone deleting the older versions of the rules.
            if (previousState) {
                const logObsoleteRule = () => {
                    LogService.info('BanList', `In BanList ${this.roomRef}, conflict between rules ${event['event_id']} (with obsolete type ${event['type']}) ` +
                        `and ${previousState['event_id']} (with standard type ${previousState['type']}). Ignoring rule with obsolete type.`);
                }
                if (kind === RULE_USER && USER_RULE_TYPES.indexOf(event['type']) > USER_RULE_TYPES.indexOf(previousState['type'])) {
                    logObsoleteRule();
                    continue;
                } else if (kind === RULE_ROOM && ROOM_RULE_TYPES.indexOf(event['type']) > ROOM_RULE_TYPES.indexOf(previousState['type'])) {
                    logObsoleteRule();
                    continue;
                } else if (kind === RULE_SERVER && SERVER_RULE_TYPES.indexOf(event['type']) > SERVER_RULE_TYPES.indexOf(previousState['type'])) {
                    logObsoleteRule();
                    continue;
                }
            }

            // The reason we set the state at this point is because it is valid to want to set the state to an invalid rule
            // in order to mark a rule as deleted.
            // We always set state with the normalised state type via `kind` to de-duplicate rules.
            this.setState(kind, event['state_key'], event);
            const changeType: null|ChangeType = (() => {
                if (!previousState) {
                    return ChangeType.Added;
                } else if (previousState['event_id'] === event['event_id']) {
                    if (event['unsigned']?.['redacted_because']) {
                        return ChangeType.Removed;
                    } else {
                        // Nothing has changed.
                        return null;
                    }
                } else {
                    // Then the policy has been modified in some other way, possibly 'soft' redacted by a new event with empty content...
                    if (Object.keys(event['content']).length === 0) {
                        return ChangeType.Removed;
                    } else {
                        return ChangeType.Modified;
                    }
                }
            })();

            // If we haven't got any information about what the rule used to be, then it wasn't a valid rule to begin with
            // and so will not have been used. Removing a rule like this therefore results in no change.
            if (changeType === ChangeType.Removed && previousState?.unsigned?.rule) {
                const sender = event.unsigned['redacted_because'] ? event.unsigned['redacted_because']['sender'] : event.sender;
                changes.push({changeType, event, sender, rule: previousState.unsigned.rule,
                    ... previousState ? {previousState} : {} });
                // Event has no content and cannot be parsed as a ListRule.
                continue;
            }
            // It's a rule - parse it
            const content = event['content'];
            if (!content) continue;

            const entity = content['entity'];
            const recommendation = content['recommendation'];
            const reason = content['reason'] || '<no reason>';

            if (!entity || !recommendation) {
                continue;
            }
            const rule = new ListRule(entity, recommendation, reason, kind);
            event.unsigned.rule = rule;
            if (changeType) {
                changes.push({rule, changeType, event, sender: event.sender, ... previousState ? {previousState} : {} });
            }
        }
        this.emit('BanList.update', this, changes);
        return changes;
    }

    /**
     * Inform the `BanList` about a new event from the room it is modelling.
     * @param event An event from the room the `BanList` models to inform an instance about.
     */
    public updateForEvent(event: { event_id: string }): void {
        this.batcher.addToBatch(event.event_id)
    }
}

export default BanList;

/**
 * Helper class that emits a batch event on a `BanList` when it has made a batch
 * out of the events given to `addToBatch`.
 */
class UpdateBatcher {
    // Whether we are waiting for more events to form a batch.
    private isWaiting = false;
    // The latest (or most recent) event we have received.
    private latestEventId: string|null = null;
    private readonly waitPeriodMS = 200; // 200ms seems good enough.
    private readonly maxWaitMS = 3000; // 3s is long enough to wait while batching.

    constructor(private readonly banList: BanList) {

    }

    /**
     * Reset the state for the next batch.
     */
    private reset() {
        this.latestEventId = null;
        this.isWaiting = false;
    }

    /**
     * Checks if any more events have been added to the current batch since
     * the previous iteration, then keep waiting up to `this.maxWait`, otherwise stop
     * and emit a batch.
     * @param eventId The id of the first event for this batch.
     */
    private async checkBatch(eventId: string): Promise<void> {
        let start = Date.now();
        do {
            await new Promise(resolve => setTimeout(resolve, this.waitPeriodMS));
        } while ((Date.now() - start) < this.maxWaitMS && this.latestEventId !== eventId)
        this.reset();
        this.banList.emit('BanList.batch', this.banList);
    }

    /**
     * Adds an event to the batch.
     * @param eventId The event to inform the batcher about.
     */
    public addToBatch(eventId: string): void {
        if (this.isWaiting) {
            this.latestEventId = eventId;
            return;
        }
        this.latestEventId = eventId;
        this.isWaiting = true;
        // We 'spawn' off here after performing the checks above
        // rather than before (ie if `addToBatch` was async) because
        // `banListTest` showed that there were 100~ ACL events per protected room
        // as compared to just 5~ by doing this. Not entirely sure why but it probably
        // has to do with queuing up `n event` tasks on the event loop that exaust scheduling
        // (so the latency between them is percieved as much higher by
        // the time they get checked in `this.checkBatch`, thus batching fails).
        this.checkBatch(eventId);
    }
}
