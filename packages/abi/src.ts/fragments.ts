"use strict";

import { BigNumber } from "@ethersproject/bignumber";
import * as errors from "@ethersproject/errors";
import { defineReadOnly, isNamedInstance } from "@ethersproject/properties";


export interface JsonFragmentType {
    name?: string;
    indexed?: boolean;
    type?: string;
    components?: Array<JsonFragmentType>;
}

export interface JsonFragment {
    name?: string;
    type?: string;

    anonymous?: boolean;

    payable?: boolean;
    constant?: boolean;
    stateMutability?: string;

    inputs?: Array<JsonFragmentType>;
    outputs?: Array<JsonFragmentType>;

    gas?: string;
};


const _constructorGuard = { };

// AST Node parser state
type ParseState = {
    allowArray?: boolean,
    allowName?: boolean,
    allowParams?: boolean,
    allowType?: boolean,
    readArray?: boolean,
};

// AST Node
type ParseNode = {
    parent?: any,
    type?: string,
    name?: string,
    state?: ParseState,
    indexed?: boolean,
    components?: Array<ParseNode>
};

let storageClasses: { [ name: string ]: boolean } = { calldata: true, memory: true, storage: true };

// @TODO: Make sure that children of an indexed tuple are marked with a null indexed
function parseParamType(param: string, allowIndexed: boolean): ParseNode {

    let originalParam = param;
    function throwError(i: number) {
        throw new Error("unexpected character '" + originalParam[i] + "' at position " + i + " in '" + originalParam + "'");
    }
    param = param.replace(/\s/g, " ");

    function newNode(parent: ParseNode): ParseNode {
        let node: ParseNode = { type: "", name: "", parent: parent, state: { allowType: true } };
        if (allowIndexed) { node.indexed = false; }
        return node
    }

    let parent: ParseNode = { type: "", name: "", state: { allowType: true } };
    let node = parent;

    for (let i = 0; i < param.length; i++) {
        let c = param[i];
        switch (c) {
            case "(":
                if (!node.state.allowParams) { throwError(i); }
                node.state.allowType = false;
                node.type = verifyType(node.type);
                node.components = [ newNode(node) ];
                node = node.components[0];
                break;

            case ")":
                delete node.state;

                if (node.name === "indexed") {
                    if (!allowIndexed) { throwError(i); }
                    node.indexed = true;
                    node.name = "";
                }

                if (storageClasses[node.name]) { node.name = ""; }

                node.type = verifyType(node.type);

                let child = node;
                node = node.parent;
                if (!node) { throwError(i); }
                delete child.parent;
                node.state.allowParams = false;
                node.state.allowName = true;
                node.state.allowArray = true;
                break;

            case ",":
                delete node.state;

                if (node.name === "indexed") {
                    if (!allowIndexed) { throwError(i); }
                    node.indexed = true;
                    node.name = "";
                }

                if (storageClasses[node.name]) { node.name = ""; }

                node.type = verifyType(node.type);

                let sibling: ParseNode = newNode(node.parent);
                 //{ type: "", name: "", parent: node.parent, state: { allowType: true } };
                node.parent.components.push(sibling);
                delete node.parent;
                node = sibling;
                break;

            // Hit a space...
            case " ":

                // If reading type, the type is done and may read a param or name
                if (node.state.allowType) {
                    if (node.type !== "") {
                        node.type = verifyType(node.type);
                        delete node.state.allowType;
                        node.state.allowName = true;
                        node.state.allowParams = true;
                    }
                }

                // If reading name, the name is done
                if (node.state.allowName) {
                    if (node.name !== "") {
                        if (node.name === "indexed") {
                            if (!allowIndexed) { throwError(i); }
                            if (node.indexed) { throwError(i); }
                            node.indexed = true;
                            node.name = "";
                        } else if (storageClasses[node.name]) {
                            node.name = "";
                        } else {
                            node.state.allowName = false;
                        }
                    }
                }

                break;

            case "[":
                if (!node.state.allowArray) { throwError(i); }

                node.type += c;

                node.state.allowArray = false;
                node.state.allowName = false;
                node.state.readArray = true;
                break;

            case "]":
                if (!node.state.readArray) { throwError(i); }

                node.type += c;

                node.state.readArray = false;
                node.state.allowArray = true;
                node.state.allowName = true;
                break;

            default:
                if (node.state.allowType) {
                    node.type += c;
                    node.state.allowParams = true;
                    node.state.allowArray = true;
                } else if (node.state.allowName) {
                    node.name += c;
                    delete node.state.allowArray;
                } else if (node.state.readArray) {
                    node.type += c;
                } else {
                    throwError(i);
               }
        }
    }

    if (node.parent) { throw new Error("unexpected eof"); }

    delete parent.state;

    if (node.name === "indexed") {
        if (!allowIndexed) { throwError(originalParam.length - 7); }
        if (node.indexed) { throwError(originalParam.length - 7); }
        node.indexed = true;
        node.name = "";
    } else if (storageClasses[node.name]) {
        node.name = "";
    }

    parent.type = verifyType(parent.type);

    return parent;
}

function populate(object: any, params: any) {
    for (let key in params) { defineReadOnly(object, key, params[key]); }
}

const paramTypeArray = new RegExp(/^(.*)\[([0-9]*)\]$/);

export class ParamType {

    // The local name of the parameter (of null if unbound)
    readonly name: string;

    // The fully qualified type (e.g. "address", "tuple(address)", "uint256[3][]"
    readonly type: string;

    // The base type (e.g. "address", "tuple", "array")
    readonly baseType: string;

    // Indexable Paramters ONLY (otherwise null)
    readonly indexed: boolean;

    // Tuples ONLY: (otherwise null)
    //  - sub-components
    readonly components: Array<ParamType>;

    // Arrays ONLY: (otherwise null)
    //  - length of the array (-1 for dynamic length)
    //  - child type
    readonly arrayLength: number;
    readonly arrayChildren: ParamType;

    constructor(constructorGuard: any, params: any) {
        if (constructorGuard !== _constructorGuard) { throw new Error("use fromString"); }
        populate(this, params);

        let match = this.type.match(paramTypeArray);
        if (match) {
            populate(this, {
                arrayLength: parseInt(match[2] || "-1"),
                arrayChildren: ParamType.fromObject({
                    type: match[1],
                    components: this.components
                }),
                baseType: "array"
            });
        } else {
            populate(this, {
                arrayLength: null,
                arrayChildren: null,
                baseType: ((this.components != null) ? "tuple": this.type)
            });
        }
    }

    // Format the parameter fragment
    //   - non-expanded: "(uint256,address)"
    //   - expanded:     "tuple(uint256 foo, addres bar) indexed baz"
    format(expanded?: boolean): string {
        let result = "";

        // Array
        if (this.baseType === "array") {
            result += this.arrayChildren.format(expanded);
            result += "[" + (this.arrayLength < 0 ? "": String(this.arrayLength)) + "]";
        } else {
            if (this.baseType === "tuple") {
                if (expanded) {
                    result += this.type;
                }
                result += "(" + this.components.map((c) => c.format(expanded)).join(expanded ? ", ": ",") + ")";
            } else {
                result += this.type;
            }
        }

        if (expanded) {
            if (this.indexed === true) { result += " indexed"; }
            if (this.name) { result += " " + this.name; }
        }

        return result;
    }

    static from(value: string | JsonFragmentType | ParamType, allowIndexed?: boolean): ParamType {
        if (typeof(value) === "string") {
            return ParamType.fromString(value, allowIndexed);
        }
        return ParamType.fromObject(value);
    }

    static fromObject(value: JsonFragmentType | ParamType): ParamType {
        if (isNamedInstance<ParamType>(ParamType, value)) { return value; }

        return new ParamType(_constructorGuard, {
            name: (value.name || null),
            type: verifyType(value.type),
            indexed: ((value.indexed == null) ? null: !!value.indexed),
            components: (value.components ? value.components.map(ParamType.fromObject): null)
        });
    }

    static fromString(value: string, allowIndexed?: boolean): ParamType {
        function ParamTypify(node: ParseNode): ParamType {
            return ParamType.fromObject({
                name: node.name,
                type: node.type,
                indexed: node.indexed,
                components: node.components
            });
        }

        return ParamTypify(parseParamType(value, !!allowIndexed));
    }
};

function parseParams(value: string, allowIndex: boolean): Array<ParamType> {
    return splitNesting(value).map((param) => ParamType.fromString(param, allowIndex));
}

export abstract class Fragment {

    readonly type: string;
    readonly name: string;
    readonly inputs: Array<ParamType>;

    constructor(constructorGuard: any, params: any) {
        if (constructorGuard !== _constructorGuard) { throw new Error("use a static from method"); }
        populate(this, params);
    }

    // @TOOD: move logic to sub-classes; make this abstract
    format(expanded?: boolean): string {
        let result = "";

        if (this.type === "constructor") {
            result += "constructor";
        } else {
            if (expanded) {
                result += this.type + " ";
            }
            result += this.name;
        }

        result += "(" + this.inputs.map((i) => i.format(expanded)).join(expanded ? ", ": ",") + ") ";

        // @TODO: Handle returns, modifiers, etc.
        if (expanded && this.type !== "event") {
            result += "public ";
            if ((<any>this).mutabilityState) {
                result += (<any>this).mutabilityState + " ";
            } else if ((<any>this).constant) {
                result += "view ";
            }

            if ((<any>this).outputs && (<any>this).outputs.length) {
                result += "returns (" + (<any>this).outputs.map((i: ParamType) => i.format(expanded)).join(", ") + ") ";
            }
        }

        return result.trim();
    }

    static from(value: Fragment | JsonFragment | string): Fragment {
        if (typeof(value) === "string") {
            return Fragment.fromString(value);
        }
        return Fragment.fromObject(value);
    }

    static fromObject(value: Fragment | JsonFragment): Fragment {
        if (isNamedInstance<Fragment>(Fragment, value)) { return value; }

        if (value.type === "function") {
            return FunctionFragment.fromObject(value);
        } else if (value.type === "event") {
           return EventFragment.fromObject(value);
        } else if (value.type === "constructor") {
           return ConstructorFragment.fromObject(value);
        } else if (value.type === "fallback") {
            // @TODO:
            return null;
        }

        return errors.throwError("invalid fragment object", errors.INVALID_ARGUMENT, {
            argument: "value",
            value: value
        });
    }

    static fromString(value: string): Fragment {
        // Make sure the "returns" is surrounded by a space and all whitespace is exactly one space
        value = value.replace(/\s/g, " ");
        value = value.replace(/\(/g, " (").replace(/\)/g, ") ").replace(/\s+/g, " ");
        value = value.trim();

        if (value.split(" ")[0] === "event") {
           return EventFragment.fromString(value.substring(5).trim());
        } else if (value.split(" ")[0] === "function") {
            return FunctionFragment.fromString(value.substring(8).trim());
        } else if (value.split("(")[0].trim() === "constructor") {
            return ConstructorFragment.fromString(value.trim());
        }

        throw new Error("unknown fragment");
    }
}

export class EventFragment extends Fragment {
    readonly anonymous: boolean;

    static from(value: EventFragment | JsonFragment | string): EventFragment {
        if (typeof(value) === "string") {
            return EventFragment.fromString(value);
        }
        return EventFragment.fromObject(value);
    }

    static fromObject(value: JsonFragment | EventFragment): EventFragment {
        if (isNamedInstance<EventFragment>(EventFragment, value)) { return value; }

        if (value.type !== "event") { throw new Error("invalid event object - " + value.type); }

        return new EventFragment(_constructorGuard, {
            name: verifyIdentifier(value.name),
            anonymous: value.anonymous,
            inputs: (value.inputs ? value.inputs.map(ParamType.fromObject) : []),
            type: "event"
        });
    }

    static fromString(value: string): EventFragment {

        let match = value.match(regexParen);
        if (!match) { throw new Error("invalid event: " + value); }

        let anonymous = false;
        match[3].split(" ").forEach((modifier) => {
            switch(modifier.trim()) {
                case "anonymous":
                    anonymous = true;
                    break;
                case "":
                    break;
                default:
                    errors.warn("unknown modifier: " + modifier);
            }
        });

        return EventFragment.fromObject({
            name: match[1].trim(),
            anonymous: anonymous,
            inputs: parseParams(match[2], true),
            type: "event"
        });
    }
}

function parseGas(value: string, params: any): string {
    params.gas = null;

    let comps = value.split("@");
    if (comps.length !== 1) {
        if (comps.length > 2) {
            throw new Error("invalid signature");
        }
        if (!comps[1].match(/^[0-9]+$/)) {
            throw new Error("invalid signature gas");
        }
        params.gas = BigNumber.from(comps[1]);
        return comps[0];
    }

    return value;
}

function parseModifiers(value: string, params: any): void {
    params.constant = false;
    params.payable = false;
    // @TODO: Should this be initialized to "nonpayable"?
    params.stateMutability = "nonpayable";

    value.split(" ").forEach((modifier) => {
        switch (modifier.trim()) {
            case "constant":
                params.constant = true;
                break;
            case "payable":
                params.payable = true;
                params.stateMutability = "payable";
                break;
            case "pure":
                params.constant = true;
                params.stateMutability = "pure";
                break;
            case "view":
                params.constant = true;
                params.stateMutability = "view";
                break;
            case "external":
            case "public":
            case "":
                break;
            default:
                console.log("unknown modifier: " + modifier);
        }
    });
}

export class ConstructorFragment extends Fragment {
    stateMutability: string;
    payable: boolean;
    gas?: BigNumber;

    static from(value: ConstructorFragment | JsonFragment | string): ConstructorFragment {
        if (typeof(value) === "string") {
            return ConstructorFragment.fromString(value);
        }
        return ConstructorFragment.fromObject(value);
    }

    static fromObject(value: ConstructorFragment | JsonFragment): ConstructorFragment {
        if (isNamedInstance<ConstructorFragment>(ConstructorFragment, value)) { return value; }

        if (value.type !== "constructor") { throw new Error("invalid constructor object - " + value.type); }

        return new ConstructorFragment(_constructorGuard, {
            type: value.type,
            inputs: (value.inputs ? value.inputs.map(ParamType.fromObject): []),
            payable: ((value.payable == null) ? true: !!value.payable),
            gas: (value.gas ? BigNumber.from(value.gas): null)
        });
    }

    static fromString(value: string): ConstructorFragment {
        let params: any = { type: "constructor" };

        value = parseGas(value, params);

        let parens = value.match(regexParen);
        if (!parens) { throw new Error("invalid constructor: " + value); }

        if (parens[1].trim() !== "constructor") { throw new Error("invalid constructor"); }

        params.inputs = parseParams(parens[2].trim(), false);

        parseModifiers(parens[3].trim(), params);

        return ConstructorFragment.fromObject(params);
    }

}

export class FunctionFragment extends ConstructorFragment {
    constant: boolean;
    outputs?: Array<ParamType>;

    static from(value: FunctionFragment | JsonFragment | string): FunctionFragment {
        if (typeof(value) === "string") {
            return FunctionFragment.fromString(value);
        }
        return FunctionFragment.fromObject(value);
    }

    static fromObject(value: FunctionFragment | JsonFragment): FunctionFragment {
        if (isNamedInstance<FunctionFragment>(FunctionFragment, value)) { return value; }

        if (value.type !== "function") { throw new Error("invalid function object - " + value.type); }

        return new FunctionFragment(_constructorGuard, {
            type: value.type,
            name: verifyIdentifier(value.name),
            constant: !!value.constant,
            inputs: (value.inputs ? value.inputs.map(ParamType.fromObject): []),
            outputs: (value.outputs ? value.outputs.map(ParamType.fromObject): [ ]),
            payable: ((value.payable == null) ? true: !!value.payable),
            stateMutability: ((value.stateMutability != null) ?verifyString(value.stateMutability): null),
            gas: (value.gas ? BigNumber.from(value.gas): null)
        });
    }

    static fromString(value: string): FunctionFragment {
        let params: any = { type: "function" };
        value = parseGas(value, params);

        let comps = value.split(" returns ");
        if (comps.length > 2) { throw new Error("invalid function"); }

        let parens = comps[0].match(regexParen);
        if (!parens) { throw new Error("invalid signature"); }

        params.name = parens[1].trim();
        if (!params.name.match(regexIdentifier)) {
            throw new Error("invalid identifier: '" + params.name + "'");
        }

        params.inputs = parseParams(parens[2], false);

        parseModifiers(parens[3].trim(), params);

        // We have outputs
        if (comps.length > 1) {
           let returns = comps[1].match(regexParen);
            if (returns[1].trim() != "" || returns[3].trim() != "") {
                throw new Error("unexpected tokens");
            }
            params.outputs = parseParams(returns[2], false);
        } else {
            params.outputs = [ ];
        }

        return FunctionFragment.fromObject(params);
    }
}

//export class ErrorFragment extends Fragment {
//}

//export class StructFragment extends Fragment {
//}

function verifyString(value: string): string {
    if (typeof(value) !== "string") { throw new Error("requires a string"); }
    return value;
}

function verifyType(type: string): string {

    // These need to be transformed to their full description
    if (type.match(/^uint($|[^1-9])/)) {
        type = "uint256" + type.substring(4);
    } else if (type.match(/^int($|[^1-9])/)) {
        type = "int256" + type.substring(3);
    }

    // @TODO: more verification

    return type;
}

const regexIdentifier = new RegExp("^[A-Za-z_][A-Za-z0-9_]*$");
function verifyIdentifier(value: string): string {
    if (!value || !value.match(regexIdentifier)) {
        throw new Error("invalid identifier: '" + value + "'");
    }
    return value;
}

const regexParen = new RegExp("^([^)(]*)\\((.*)\\)([^)(]*)$");

function splitNesting(value: string): Array<any> {
    value = value.trim();

    let result = [];
    let accum = "";
    let depth = 0;
    for (let offset = 0; offset < value.length; offset++) {
        let c = value[offset];
        if (c === "," && depth === 0) {
            result.push(accum);
            accum = "";
        } else {
            accum += c;
            if (c === "(") {
                depth++;
            } else if (c === ")") {
                depth--;
                if (depth === -1) {
                    throw new Error("unbalanced parenthsis");
                }
            }
        }
    }
    if (accum) { result.push(accum); }

    return result;
}
