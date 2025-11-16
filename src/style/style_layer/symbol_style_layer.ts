import '../style_spec_extensions';

import {StyleLayer} from '../style_layer';

import {SymbolBucket, type SymbolFeature} from '../../data/bucket/symbol_bucket';
import {resolveTokens} from '../../util/resolve_tokens';
import properties, {type SymbolLayoutPropsPossiblyEvaluated, type SymbolPaintPropsPossiblyEvaluated} from './symbol_style_layer_properties.g';
import {containsColorMarker, defaultSplitChars} from '../../data/bucket/color_split';

import {
    type Transitionable,
    type Transitioning,
    type Layout,
    type PossiblyEvaluated,
    PossiblyEvaluatedPropertyValue,
    type PropertyValue
} from '../properties';

import {
    isExpression,
    StyleExpression,
    ZoomConstantExpression,
    ZoomDependentExpression,
    FormattedType,
    typeOf,
    Formatted,
    FormatExpression,
    Literal} from '@maplibre/maplibre-gl-style-spec';

import type {BucketParameters} from '../../data/bucket';
import type {SymbolLayoutProps, SymbolPaintProps} from './symbol_style_layer_properties.g';
import type {EvaluationParameters} from '../evaluation_parameters';
import type {Expression, Feature, SourceExpression, LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {CanonicalTileID} from '../../tile/tile_id';
import {FormatSectionOverride} from '../format_section_override';

export const isSymbolStyleLayer = (layer: StyleLayer): layer is SymbolStyleLayer => layer.type === 'symbol';

export class SymbolStyleLayer extends StyleLayer {
    _unevaluatedLayout: Layout<SymbolLayoutProps>;
    layout: PossiblyEvaluated<SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated>;

    _transitionablePaint: Transitionable<SymbolPaintProps>;
    _transitioningPaint: Transitioning<SymbolPaintProps>;
    paint: PossiblyEvaluated<SymbolPaintProps, SymbolPaintPropsPossiblyEvaluated>;

    constructor(layer: LayerSpecification, globalState: Record<string, any>) {
        super(layer, properties, globalState);
    }

    recalculate(parameters: EvaluationParameters, availableImages: Array<string>) {
        super.recalculate(parameters, availableImages);

        if (this.layout.get('icon-rotation-alignment') === 'auto') {
            if (this.layout.get('symbol-placement') !== 'point') {
                this.layout._values['icon-rotation-alignment'] = 'map';
            } else {
                this.layout._values['icon-rotation-alignment'] = 'viewport';
            }
        }

        if (this.layout.get('text-rotation-alignment') === 'auto') {
            if (this.layout.get('symbol-placement') !== 'point') {
                this.layout._values['text-rotation-alignment'] = 'map';
            } else {
                this.layout._values['text-rotation-alignment'] = 'viewport';
            }
        }

        // If unspecified, `*-pitch-alignment` inherits `*-rotation-alignment`
        if (this.layout.get('text-pitch-alignment') === 'auto') {
            this.layout._values['text-pitch-alignment'] = this.layout.get('text-rotation-alignment') === 'map' ? 'map' : 'viewport';
        }
        if (this.layout.get('icon-pitch-alignment') === 'auto') {
            this.layout._values['icon-pitch-alignment'] = this.layout.get('icon-rotation-alignment');
        }

        if (this.layout.get('symbol-placement') === 'point') {
            const writingModes = this.layout.get('text-writing-mode');
            if (writingModes) {
                // remove duplicates, preserving order
                const deduped = [];
                for (const m of writingModes) {
                    if (deduped.indexOf(m) < 0) deduped.push(m);
                }
                this.layout._values['text-writing-mode'] = deduped;
            } else {
                this.layout._values['text-writing-mode'] = ['horizontal'];
            }
        }

        this._setPaintOverrides();
    }

    getValueAndResolveTokens(name: any, feature: Feature, canonical: CanonicalTileID, availableImages: Array<string>) {
        const value = this.layout.get(name).evaluate(feature, {}, canonical, availableImages);
        const unevaluated = this._unevaluatedLayout._values[name];
        if (!unevaluated.isDataDriven() && !isExpression(unevaluated.value) && value) {
            return resolveTokens(feature.properties, value);
        }

        return value;
    }

    createBucket(parameters: BucketParameters<any>) {
        return new SymbolBucket(parameters);
    }

    queryRadius(): number {
        return 0;
    }

    queryIntersectsFeature(): boolean {
        throw new Error('Should take a different path in FeatureIndex');
    }

    _setPaintOverrides() {
        for (const overridable of properties.paint.overridableProperties) {
            if (!SymbolStyleLayer.hasPaintOverride(this.layout, overridable)) {
                continue;
            }
            const overridden = this.paint.get(overridable as keyof SymbolPaintPropsPossiblyEvaluated) as PossiblyEvaluatedPropertyValue<number>;
            const override = new FormatSectionOverride(overridden);
            const styleExpression = new StyleExpression(override, overridden.property.specification);
            let expression = null;
            if (overridden.value.kind === 'constant' || overridden.value.kind === 'source') {
                expression = new ZoomConstantExpression('source', styleExpression) as SourceExpression;
            } else {
                expression = new ZoomDependentExpression('composite',
                    styleExpression,
                    overridden.value.zoomStops);
            }
            this.paint._values[overridable] = new PossiblyEvaluatedPropertyValue(overridden.property,
                expression,
                overridden.parameters);
        }
    }

    _handleOverridablePaintPropertyUpdate<T, R>(name: string, oldValue: PropertyValue<T, R>, newValue: PropertyValue<T, R>): boolean {
        if (!this.layout || oldValue.isDataDriven() || newValue.isDataDriven()) {
            return false;
        }
        return SymbolStyleLayer.hasPaintOverride(this.layout, name);
    }

    static hasPaintOverride(layout: PossiblyEvaluated<SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated>, propertyName: string): boolean {
        const property = properties.paint.properties[propertyName];
        let hasOverrides = false;

        const checkSections = (sections) => {
            for (const section of sections) {
                if (property.overrides && property.overrides.hasOverride(section)) {
                    hasOverrides = true;
                    return;
                }
            }
        };

        const checkStringForOverrides = (text: string | null | undefined) => {
            if (!text || hasOverrides) return;
            if (containsColorMarker(text, defaultSplitChars)) {
                hasOverrides = true;
            }
        };

        const checkFormatted = (formatted: Formatted) => {
            if (!formatted || hasOverrides) return;
            checkSections(formatted.sections);
        };

        const checkTextValue = (textValue: PossiblyEvaluatedPropertyValue<any>) => {
            if (!textValue || hasOverrides) return;

            if (textValue.value.kind === 'constant') {
                const constantValue = textValue.value.value;
                if (constantValue instanceof Formatted) {
                    checkFormatted(constantValue);
                } else if (typeof constantValue === 'string') {
                    checkStringForOverrides(constantValue);
                }
            } else if (textValue.value.kind === 'source' || textValue.value.kind === 'composite') {
                const checkExpression = (expression: Expression) => {
                    if (hasOverrides) return;

                    if (expression instanceof Literal && typeOf(expression.value) === FormattedType) {
                        const formatted: Formatted = (expression.value as any);
                        checkFormatted(formatted);
                    } else if (expression instanceof Literal && typeof expression.value === 'string') {
                        checkStringForOverrides(expression.value);
                    } else if (expression instanceof FormatExpression) {
                        checkSections(expression.sections);
                    } else {
                        expression.eachChild(checkExpression);
                    }
                };

                const expr: ZoomConstantExpression<'source'> = (textValue.value as any);
                if (expr._styleExpression) {
                    checkExpression(expr._styleExpression.expression);
                }
            }
        };

        checkTextValue(layout.get('text-field'));
        checkTextValue(layout.get('text-field2' as any));

        return hasOverrides;
    }
}

export type SymbolPadding = [number, number, number, number];

export function getIconPadding(layout: PossiblyEvaluated<SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated>, feature: SymbolFeature, canonical: CanonicalTileID, pixelRatio = 1): SymbolPadding {
    // Support text-padding in addition to icon-padding? Unclear how to apply asymmetric text-padding to the radius for collision circles.
    const result = layout.get('icon-padding').evaluate(feature, {}, canonical);
    const values = result && result.values;

    return [
        values[0] * pixelRatio,
        values[1] * pixelRatio,
        values[2] * pixelRatio,
        values[3] * pixelRatio,
    ];
}
