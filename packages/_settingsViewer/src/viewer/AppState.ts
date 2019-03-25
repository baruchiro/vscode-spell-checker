import {observable, computed} from 'mobx';
import { Settings, ConfigTarget, LocalId, SettingByConfigTarget, Config, Configs, LocalList, WorkspaceFolder, TextDocument, configTargets, ConfigTargets } from '../api/settings/';
import { normalizeCode, lookupCode } from '../iso639-1';
import { compareBy, compareEach } from '../api/utils/Comparable';
import { uniqueFilter } from '../api/utils';
import { Messenger } from '../api';


type Maybe<T> = T | undefined;
type TabTargets = ConfigTarget | 'file' | 'dictionaries' | 'about';

export interface Tab {
    label: string;
    target: TabTargets;
}

const tabs: Tab[] = [
    { label: 'User', target: 'user' },
    { label: 'Workspace', target: 'workspace' },
    { label: 'Folder', target: 'folder' },
    { label: 'File', target: 'file' },
    { label: 'Dictionaries', target: 'dictionaries' },
    { label: 'About', target: 'about' },
];

export interface LanguageInfo {
    code: string;
    name: string;
    dictionaries: string[];
    enabled: boolean;
}

export interface LanguageConfig {
    languages: LanguageInfo[];
    inherited?: ConfigTarget;
}

export interface LanguageConfigs extends SettingByConfigTarget<LanguageConfig> {}

export interface State {
    activeTabName: string;
    settings: Settings;
    tabs: Tab[];
    activeTab: Tab;
    languageConfig: LanguageConfigs;
}

export interface FoundInConfig<T> {
    value: Exclude<T, undefined>,
    target: ConfigTarget
}

type InheritedFromTarget<T> = undefined | {
    value: Exclude<T, undefined>,
    target: ConfigTarget;
}


type InheritMembers<T> = {
    [K in keyof T]: InheritedFromTarget<T[K]>;
}

type InheritedConfig = InheritMembers<Config>;
type InheritedConfigs = SettingByConfigTarget<InheritedConfig>;

export class AppState implements State {
    @observable activeTabName = '';
    @observable settings: Settings = {
        dictionaries: [
        ],
        configs: {
            user: undefined,
            workspace: undefined,
            folder: undefined,
            file: undefined,
        }
    };
    @observable debugMode: boolean = false;

    constructor(private messageBus: Messenger) {}

    @computed get tabs() {
        const hidden = new Set<TabTargets>(configTargets.filter(target => !this.settings.configs[target]));
        if (this.workspaceFolders.length <= 1) {
            hidden.add(ConfigTargets.folder);
        }
        return tabs.filter(tab => !hidden.has(tab.target));
    }

    @computed get activeTab() {
        return this.tabs.find(t => t.label === this.activeTabName) || this.tabs[0];
    }

    @computed get languageConfig(): LanguageConfigs {
        const calcConfig = (target: ConfigTarget): LanguageConfig => {
            const config = this.inheritedConfigs[target];
            if (!config) {
                return { languages: [] };
            }
            const locals = config.locals; // todo: calc inheritance
            const inherited = locals && locals.target;

            const infos = new Map<string, LanguageInfo>();

            const addLocalsToInfos = (locals: string[], dictionaryName: string | undefined) => {
                locals.map(normalizeCode).map(lookupCode).filter(notUndefined).forEach(lang => {
                    const { code, lang: language, country } = lang;
                    const name = country ? `${language} - ${country}` : language;
                    const found = this.isLocalEnabledEx(target, code);
                    const enabled = found && found.value || false;
                    const info: LanguageInfo = infos.get(name) || {
                        code,
                        name,
                        enabled,
                        dictionaries: [],
                    };
                    if (dictionaryName) {
                        info.dictionaries.push(dictionaryName);
                    }
                    infos.set(name, info);
                });
            }
            if (locals) {
                addLocalsToInfos(locals.value, undefined);
            }
            this.settings.dictionaries.forEach(dict => addLocalsToInfos(dict.locals, dict.name));

            return {
                languages: [...infos.values()].sort(compareEach(
                    compareBy(info => !info.dictionaries.length),
                    compareBy('name'),
                )),
                inherited
            };
        };

        return {
            user: calcConfig('user'),
            workspace: calcConfig('workspace'),
            folder: calcConfig('folder'),
        }
    }

    @computed get inheritedConfigs(): InheritedConfigs {
        return calcInheritableConfig(this.settings.configs);
    }

    @computed get activeTabIndex(): number {
        const index = this.tabs.findIndex(t => t.label === this.activeTabName);
        return index > 0 ? index : 0;
    }

    @computed get workspaceFolderNames(): string[] {
        const workspace = this.settings.workspace;
        const folders = workspace && workspace.workspaceFolders || [];
        return folders.map(f => f.name);
    }

    @computed get activeWorkspaceFolder(): string | undefined {
        const folder = this.findMatchingFolder(this.settings.activeFolderUri);
        return folder && folder.name;
    }

    @computed get workspaceFolders(): WorkspaceFolder[] {
        const workspace = this.settings.workspace;
        return workspace && workspace.workspaceFolders || [];
    }

    @computed get activeFileUri(): string | undefined {
        return this.settings.activeFileUri;
    }

    @computed get documents(): TextDocument[] {
        const workspace = this.settings.workspace;
        return workspace && workspace.textDocuments || [];
    }

    @computed get documentSelection(): { label: string, value: string }[] {
        return this.documents.map(doc => ({ label: doc.fileName, value: doc.uri }));
    }

    private findMatchingFolder(uri: string | undefined): WorkspaceFolder | undefined {
        return this.workspaceFolders.filter(f => f.uri === uri)[0];
    }

    private findMatchingFolderByName(name: string | undefined): WorkspaceFolder | undefined {
        return this.workspaceFolders.filter(f => f.name === name)[0];
    }

    actionSetLocal(field: ConfigTarget, code: LocalId, checked: boolean) {
        const inherited = this.inheritedConfigs[field].locals;
        const locals = inherited && inherited.value || [];
        if (checked) {
            this.setLocals(field, [code, ...locals]);
        } else {
            const filtered = locals.filter(a => a !== code);
            if (!filtered.length || filtered.length !== locals.length) {
                this.setLocals(field, filtered);
            }
        }
    }

    actionSetDebugMode(isEnabled: boolean) {
        this.debugMode = isEnabled;
    }

    private setLocals(target: ConfigTarget, locals: LocalList | undefined) {
        locals = locals ? locals.filter(uniqueFilter()) : undefined;
        locals = locals && locals.length ? locals : undefined;
        const config = this.settings.configs[target] || {
            locals: undefined,
            languageIdsEnabled: undefined,
        };
        config.locals = locals;
        this.settings.configs[target] = config;
    }

    private isLocalEnabledEx(field: ConfigTarget, code: LocalId):InheritedFromTarget<boolean> {
        const locals = this.inheritedConfigs[field].locals;
        if (locals === undefined) return undefined;
        return  {
            value: locals.value.map(normalizeCode).includes(code),
            target: locals.target
        };
    }

    actionActivateTabIndex(index: number) {
        const tab = this.tabs[index];
        if (tab) {
            this.actionActivateTab(tab.label);
        }
    }

    actionActivateTab(tabName: string) {
        this.activeTabName = tabName;
        this.messageBus.postMessage({ command: 'SelectTabMessage', value: this.activeTabName });
    }

    actionSelectFolder(folderName: string) {
        const folder = this.findMatchingFolderByName(folderName);
        const folderUri = folder && folder.uri;
        this.settings.activeFolderUri = folderUri;
        if (folderUri !== undefined) {
            this.messageBus.postMessage({ command: 'SelectFolderMessage', value: folderUri })
        }
    }

    actionSelectDocument(documentUri: string) {
        this.messageBus.postMessage({ command: 'SelectFileMessage', value: documentUri });
    }

    actionEnableLanguageId(languageId: string, enabled: boolean, target?: ConfigTarget) {
        const fileConfig = this.settings.configs.file;
        if (fileConfig && fileConfig.languageId === languageId) {
            fileConfig.languageEnabled = enabled;
        }
        this.messageBus.postMessage({ command: 'EnableLanguageIdMessage', value: { languageId, enabled, target }});
    }
}

function calcInheritableConfig(configs: Configs): InheritedConfigs {
    function peek(target: ConfigTarget, inherited: InheritedConfig): InheritedConfig {
        const cfg = configs[target];
        if (cfg == undefined) return inherited;
        const inCfg = {...inherited};
        for (const k of Object.keys(inherited) as (keyof InheritedConfig)[]) {
            const value = cfg[k];
            if (value !== undefined) {
                if (typeof value === 'string') {
                    inCfg[k] = { value, target };
                } else if (value.length > 0) {
                    inCfg[k] = { value, target };
                }
            }
        }
        return inCfg;
    }
    const defaultCfg: InheritedConfig = { locals: undefined, languageIdsEnabled: undefined };
    const user = peek('user', defaultCfg);
    const workspace = peek('workspace', user);
    const folder = peek('folder', workspace);
    return { user, workspace, folder };
}

function notUndefined<T>(a : T): a is Exclude<T, undefined> {
    return a !== undefined;
}

