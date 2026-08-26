export interface BdApiFacade {
    readonly React: typeof import("react");
    readonly Components: BoundComponentsApi;
    readonly Data: {
        load<T>(key: string): T | undefined;
        save(key: string, value: unknown): void;
    };
    readonly Logger: BoundLoggerApi;
    readonly UI: BoundUiApi;
    readonly Webpack: BoundWebpackApi;
    readonly ContextMenu: BoundContextMenuApi;
}

export interface BoundComponentsApi {
    readonly Button: BoundButtonComponent;
    readonly DropdownInput: import("react").ComponentType<BoundDropdownInputProps>;
    readonly Flex: BoundFlexComponent;
    readonly NumberInput: import("react").ComponentType<BoundNumberInputProps>;
    readonly RadioInput: import("react").ComponentType<BoundRadioInputProps>;
    readonly SearchInput: import("react").ComponentType<BoundSearchInputProps>;
    readonly SettingGroup: import("react").ComponentType<BoundSettingGroupProps>;
    readonly SettingItem: import("react").ComponentType<BoundSettingItemProps>;
    readonly SwitchInput: import("react").ComponentType<BoundSwitchInputProps>;
    readonly Text: BoundTextComponent;
    readonly TextInput: import("react").ComponentType<BoundTextInputProps>;
}

export type BoundFlexComponent = import("react").ComponentType<BoundFlexProps> & {
    readonly Child: import("react").ComponentType<BoundFlexProps>;
    readonly Direction: {
        readonly VERTICAL: string;
        readonly HORIZONTAL: string;
        readonly HORIZONTAL_REVERSE: string;
    };
    readonly Align: {
        readonly START: string;
        readonly END: string;
        readonly CENTER: string;
        readonly STRETCH: string;
        readonly BASELINE: string;
    };
    readonly Justify: {
        readonly START: string;
        readonly END: string;
        readonly CENTER: string;
        readonly BETWEEN: string;
        readonly AROUND: string;
    };
    readonly Wrap: {
        readonly NO_WRAP: string;
        readonly WRAP: string;
        readonly WRAP_REVERSE: string;
    };
};

export type BoundFlexProps = import("react").HTMLAttributes<HTMLDivElement> & {
    shrink?: number;
    grow?: number;
    basis?: string | number;
    direction?: string;
    align?: string;
    justify?: string;
    wrap?: string;
};

export type BoundTextComponent = import("react").ComponentType<BoundTextProps> & {
    readonly Colors: {
        readonly STANDARD: string;
        readonly MUTED: string;
        readonly ERROR: string;
        readonly BRAND: string;
        readonly LINK: string;
        readonly HEADER_PRIMARY: string;
        readonly HEADER_SECONDARY: string;
        readonly STATUS_YELLOW: string;
        readonly STATUS_GREEN: string;
        readonly STATUS_RED: string;
        readonly ALWAYS_WHITE: string;
        readonly CUSTOM: null;
    };
    readonly Sizes: {
        readonly SIZE_10: string;
        readonly SIZE_12: string;
        readonly SIZE_14: string;
        readonly SIZE_16: string;
        readonly SIZE_20: string;
        readonly SIZE_24: string;
        readonly SIZE_32: string;
    };
};

export type BoundTextProps = Omit<import("react").HTMLAttributes<HTMLElement>, "color"> & {
    tag?: import("react").ElementType;
    color?: string | null;
    size?: string;
    selectable?: boolean;
    strong?: boolean;
};

export type BoundButtonComponent = import("react").ComponentType<BoundButtonProps> & {
    readonly Colors: {
        readonly BRAND: string;
        readonly PRIMARY: string;
        readonly RED: string;
    };
    readonly Looks: {
        readonly FILLED: string;
        readonly OUTLINED: string;
    };
    readonly Sizes: {
        readonly SMALL: string;
    };
};

export interface BoundButtonProps
    extends Omit<import("react").ButtonHTMLAttributes<HTMLButtonElement>, "color" | "size"> {
    color?: string;
    grow?: boolean;
    look?: string;
    size?: string;
}

export interface BoundSelectOption {
    id?: string;
    value: unknown;
    label: string;
}

export interface BoundDropdownInputProps {
    value: unknown;
    options: readonly BoundSelectOption[];
    style?: "transparent" | "default";
    disabled?: boolean;
    onChange?(value: unknown): void;
}

export interface BoundNumberInputProps {
    value: string | number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    onChange?(value: string | number): void;
}

export interface BoundRadioOption {
    name: string;
    value: unknown;
    color?: string;
    description?: string;
}

export interface BoundRadioInputProps {
    name?: string;
    value: unknown;
    options: readonly BoundRadioOption[];
    disabled?: boolean;
    onChange?(value: unknown): void;
}

export interface BoundSearchInputProps {
    defaultValue?: string;
    className?: string;
    placeholder?: string;
    onChange?(value: unknown): void;
    onKeyDown?(event: import("react").KeyboardEvent<HTMLInputElement>): void;
}

export interface BoundSettingGroupProps {
    id: string;
    name?: string;
    shown?: boolean;
    showDivider?: boolean;
    collapsible?: boolean;
    settings: readonly unknown[];
    children?: import("react").ReactNode;
}

export interface BoundSettingItemProps {
    id: string;
    name?: import("react").ReactNode;
    note?: string;
    inline?: boolean;
    children?: import("react").ReactNode;
}

export interface BoundSwitchInputProps {
    id?: string;
    value: boolean;
    disabled?: boolean;
    internalState?: boolean;
    onChange?(value?: boolean): void;
}

export interface BoundTextInputProps {
    value: string;
    maxLength?: number;
    placeholder?: string;
    disabled?: boolean;
    onKeyDown?(event: import("react").KeyboardEvent<HTMLInputElement>): void;
    onChange?(value: string): void;
}

export interface BoundLoggerApi {
    error(...data: readonly unknown[]): void;
    info(...data: readonly unknown[]): void;
    warn(...data: readonly unknown[]): void;
}

export interface BoundUiApi {
    showConfirmationModal(title: string, content: unknown, options?: Record<string, unknown>): void;
    showToast(content: string, options?: Record<string, unknown>): void;
}

export interface BoundWebpackApi {
    getStore(name: string): unknown;
    getByKeys(...keysAndOptions: Array<string | { searchExports?: boolean }>): unknown;
    getModule(filter: (value: unknown) => boolean, options?: { searchExports?: boolean }): unknown;
}

export interface BoundContextMenuApi {
    patch(
        menuId: string,
        callback: (
            tree: unknown,
            props: unknown,
            instance?: BoundContextMenuRenderInstance,
        ) => void,
    ): () => void;
    buildItem(spec: ContextMenuItem): unknown;
}

export interface BoundContextMenuRenderInstance {
    forceUpdate(): void;
}

export interface ContextMenuActionEvent {
    preventDefault(): void;
}

export interface ContextMenuTextItem {
    type: "text";
    id: string;
    label: string;
    subtext?: string;
    disabled: true;
}

export interface ContextMenuRadioItem {
    type: "radio";
    id: string;
    label: string;
    group: string;
    checked: boolean;
    action?(event: ContextMenuActionEvent): void;
}

export interface ContextMenuSubmenuItem {
    type: "submenu";
    id: string;
    label: string;
    items: readonly ContextMenuItemOrGroup[];
    action?(event: MouseEvent): void;
}

export interface ContextMenuItemGroup {
    type: "group";
    items: readonly ContextMenuLeafItem[];
}

export type ContextMenuLeafItem = ContextMenuRadioItem | ContextMenuTextItem;
export type ContextMenuItem = ContextMenuLeafItem | ContextMenuSubmenuItem;
export type ContextMenuItemOrGroup = ContextMenuItem | ContextMenuItemGroup;

declare global {
    const BdApi: new (pluginName: string) => BdApiFacade;
}
