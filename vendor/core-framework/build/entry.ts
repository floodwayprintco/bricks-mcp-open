/**
 * Headless Core Framework preset compiler.
 *
 * Mirrors the WP admin app's save path (packages/wp/src/hooks/usePush.ts +
 * packages/wp/src/state/groupsAtoms.ts joinedStylesAtom) so that a preset
 * mutated outside the browser compiles to the same stylesheet the app would
 * have produced. Everything here is assembled from Core Framework's own
 * sources at bundle time; this file only replicates the jotai plumbing that
 * cannot be imported without React.
 */
import { cssGenerator } from "cssGenerator";
import { generateColorSystemObjects } from "components/modules/colorSystem/functions/generateColorSystemObjects";
import { generateComponentsObjects } from "components/modules/components/functions/generateComponentsObjects";
import { generateSpacingObjects } from "components/modules/spacing/functions/getFluidSpacingVariables";
import { generateFluidTypographyObjects } from "components/modules/typography/functions/getFluidTypeVariables";
import { retrieveStylesFromState } from "components/modules/stylesheets/functions/retrieveStylesFromState";
import { minifyCss } from "functions/minifyCss";
import { sanitizePreset } from "functions/sanitizePreset";
import { reducedMotionString } from "constants/preferesReducedMotion";
import {
	DEFAULT_EXPAND_CLICK,
	DEFAULT_EXPAND_CLICK_CLASSNAME,
	DEFAULT_MIN_SCREEN_WIDTH,
	DEFAULT_PREFERENCES,
	DEFAULT_SR_ONLY,
	DEFAULT_SR_ONLY_CLASSNAME,
} from "data/defaults";
import { mergeArrays } from "utils";

// joinedStylesAtom's group flattener, verbatim (packages/core/src/state/groupsAtoms.ts)
function getNestedCssObjects(
	stylesGroup: any[],
	isAddGroupComments: boolean | undefined,
	includeGroupName?: boolean,
): any[] {
	return (stylesGroup || []).flatMap((group: any, i: number) => {
		const groupName = group?.name;

		if (isAddGroupComments) {
			return group?.isDisabled
				? []
				: [
						{
							id: `${groupName.replace(/\s/g, "-")}-${i}`,
							selector: `/* ${groupName} */`,
							declarations: [],
							...(includeGroupName ? { groupName } : {}),
						},
						...group.cssObjects.map((css: any) => ({
							...css,
							...(includeGroupName ? { groupName } : {}),
						})),
				  ];
		} else {
			return group?.isDisabled
				? []
				: group.cssObjects.map((css: any) => ({
						...css,
						...(includeGroupName ? { groupName } : {}),
				  }));
		}
	});
}

const getExpandClickStyles = (className: string = DEFAULT_EXPAND_CLICK_CLASSNAME): any[] => {
	return DEFAULT_EXPAND_CLICK.map((css: any) => ({
		...css,
		selector: css.selector.replace(DEFAULT_EXPAND_CLICK_CLASSNAME, className),
	}));
};

const getSROnlyStyles = (className: string = DEFAULT_SR_ONLY_CLASSNAME): any[] => {
	return DEFAULT_SR_ONLY.map((css: any) => ({
		...css,
		selector: css.selector.replace(DEFAULT_SR_ONLY_CLASSNAME, className),
	}));
};

// writeStylesFromPresetAtom's classes:[] guard for the fluid modules
function withClassesGuard(moduleData: any): any {
	if (moduleData && typeof moduleData === "object" && !("classes" in moduleData)) {
		return { ...moduleData, classes: [] };
	}
	return moduleData;
}

function checkIfHasDarkMode(colorSystemFormData: any): boolean {
	return Boolean(
		colorSystemFormData?.groups?.some(({ colors }: any) =>
			colors?.some(({ isDarkMode }: any) => isDarkMode),
		),
	);
}

// joinedStylesAtom (packages/wp/src/state/groupsAtoms.ts), fed from a raw preset
export function buildJoinedCssObjects(preset: any): any[] {
	const preferences = preset?.preferences ?? DEFAULT_PREFERENCES;
	const {
		root_font_size,
		min_screen_width,
		max_screen_width,
		is_rem,
		is_add_group_comments,
		is_clickable_parent,
		enable_sr_only,
	} = preferences;

	const screenSizeVariables: any[] = [
		{
			id: "screen-size-variables",
			selector: ":root",
			declarations: [
				...(min_screen_width
					? [{ id: "min-screen-width", property: "--min-screen-width", value: `${min_screen_width}px` }]
					: []),
				...(max_screen_width
					? [{ id: "max-screen-width", property: "--max-screen-width", value: `${max_screen_width}px` }]
					: []),
			],
		},
	];

	const modulesData = preset?.modulesData ?? {};
	const styleSheetData = preset?.styleSheetData ?? {};
	const classPrefix = preset?.classPrefix;

	const colorSystemObjects = generateColorSystemObjects({
		formData: modulesData.COLOR_SYSTEM,
		manualTheme: true,
		classPrefix,
		isAddGroupComments: is_add_group_comments,
	});

	const fluidSpacingObjects = generateSpacingObjects({
		formData: withClassesGuard(modulesData.FLUID_SPACING),
		min_screen_width: min_screen_width || DEFAULT_MIN_SCREEN_WIDTH,
		max_screen_width: max_screen_width || DEFAULT_MIN_SCREEN_WIDTH,
		is_rem: is_rem ?? true,
		root_font_size: root_font_size || 16,
		is_add_group_comments,
	});

	const fluidTypographyObjects = generateFluidTypographyObjects({
		formData: withClassesGuard(modulesData.FLUID_TYPOGRAPHY),
		min_screen_width: min_screen_width || DEFAULT_MIN_SCREEN_WIDTH,
		max_screen_width: max_screen_width || DEFAULT_MIN_SCREEN_WIDTH,
		is_rem: is_rem ?? true,
		root_font_size: root_font_size || 16,
		is_add_group_comments,
	});

	const componentsObjects = generateComponentsObjects({
		componentsData: modulesData.COMPONENTS,
		is_add_group_comments,
	});

	const preferenceStyles: any[] = [];
	is_clickable_parent && preferenceStyles.push(getExpandClickStyles(preset?.clickableParentClass));
	enable_sr_only && preferenceStyles.push(getSROnlyStyles(preset?.srOnlyClass));

	const colorStyles = getNestedCssObjects(styleSheetData.colorStyles, is_add_group_comments);
	const typographyStyles = getNestedCssObjects(styleSheetData.typographyStyles, is_add_group_comments);
	const spacingStyles = getNestedCssObjects(styleSheetData.spacingStyles, is_add_group_comments);
	const layoutsStyles = getNestedCssObjects(styleSheetData.layoutsStyles, is_add_group_comments);
	const designStyles = getNestedCssObjects(styleSheetData.designStyles, is_add_group_comments);
	const componentsStyles = getNestedCssObjects(styleSheetData.componentsStyles, is_add_group_comments);
	const otherStyles = getNestedCssObjects(styleSheetData.otherStyles, is_add_group_comments);
	const fontsStyles = getNestedCssObjects(styleSheetData.fontsStyles, is_add_group_comments);

	return mergeArrays(
		screenSizeVariables,
		componentsObjects,
		preferenceStyles,
		colorSystemObjects,
		fluidSpacingObjects,
		fluidTypographyObjects,
		colorStyles,
		typographyStyles,
		spacingStyles,
		layoutsStyles,
		designStyles,
		componentsStyles,
		otherStyles,
		fontsStyles,
	);
}

export interface CompileOptions {
	/** The Gutenberg addon appends `.wp-block{}`; read from core_framework_main local prefs. */
	gutenbergEnabled?: boolean;
}

export interface CompileResult {
	css: string;
	cssMinified: string;
	cssObjects: any[];
}

// usePush's handlePush, minus the DB writes (packages/wp/src/hooks/usePush.ts)
export async function compilePreset(preset: any, options: CompileOptions = {}): Promise<CompileResult> {
	const preferences = preset?.preferences ?? DEFAULT_PREFERENCES;
	const {
		root_font_size,
		min_screen_width,
		max_screen_width,
		prefers_reduced_motion,
		postcss,
		postcss_easing_gradients,
		postcss_hover_media,
		is_rem,
	} = preferences;

	const cssObjects = buildJoinedCssObjects(preset);

	if (root_font_size === 10) {
		cssObjects.push({
			selector: "html",
			declarations: [
				{
					property: "font-size",
					value: "62.5%",
					id: "1",
				},
			],
			id: "root-font-size",
		});
	}

	const has_theme = checkIfHasDarkMode(preset?.modulesData?.COLOR_SYSTEM);

	let cssString = await cssGenerator({
		cssObjects,
		options: {
			format: true,
			combineSelectors: true,
			propertyValidation: false,
			valueValidation: false,
			minScreenWidth: min_screen_width,
			maxScreenWidth: max_screen_width,
			manualDarkMode: has_theme,
			variablePrefix: preset?.variablePrefix,
			classPrefix: preset?.classPrefix,
			postcss,
			postcssEasingGradients: postcss_easing_gradients,
			postcssHoverMedia: postcss_hover_media,
			rootFontSize: root_font_size,
			isRem: is_rem,
		},
	});

	if (prefers_reduced_motion) cssString += reducedMotionString;
	if (options.gutenbergEnabled) cssString += ".wp-block{}";

	const stylesheetsCss = retrieveStylesFromState(preset?.modulesData?.STYLESHEETS);
	if (stylesheetsCss.length > 0) {
		cssString += "\n/* Custom Stylesheets */\n";
		cssString += stylesheetsCss.join("\n");
	}

	return {
		css: cssString,
		cssMinified: minifyCss(cssString),
		cssObjects,
	};
}

export { sanitizePreset, minifyCss };
