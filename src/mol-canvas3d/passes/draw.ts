/**
 * Copyright (c) 2019-2020 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 * @author Áron Samuel Kovács <aron.kovacs@mail.muni.cz>
 */

import { WebGLContext } from '../../mol-gl/webgl/context';
import { createNullRenderTarget, RenderTarget } from '../../mol-gl/webgl/render-target';
import Renderer from '../../mol-gl/renderer';
import Scene from '../../mol-gl/scene';
import { Texture } from '../../mol-gl/webgl/texture';
import { Camera, ICamera } from '../camera';
import { QuadSchema, QuadValues } from '../../mol-gl/compute/util';
import { DefineSpec, TextureSpec, UniformSpec, Values } from '../../mol-gl/renderable/schema';
import { ComputeRenderable, createComputeRenderable } from '../../mol-gl/renderable';
import { ShaderCode } from '../../mol-gl/shader-code';
import { createComputeRenderItem } from '../../mol-gl/webgl/render-item';
import { ValueCell } from '../../mol-util';
import { Vec2 } from '../../mol-math/linear-algebra';
import { Helper } from '../helper/helper';

import quad_vert from '../../mol-gl/shader/quad.vert';
import depthMerge_frag from '../../mol-gl/shader/depth-merge.frag';
import copyFbo_frag from '../../mol-gl/shader/copy-fbo.frag';
import { StereoCamera } from '../camera/stereo';
import { WboitPass } from './wboit';
import { FxaaPass, PostprocessingPass, PostprocessingProps } from './postprocessing';
import { Color } from '../../mol-util/color';

const DepthMergeSchema = {
    ...QuadSchema,
    tDepthPrimitives: TextureSpec('texture', 'depth', 'ushort', 'nearest'),
    tDepthVolumes: TextureSpec('texture', 'depth', 'ushort', 'nearest'),
    uTexSize: UniformSpec('v2'),
    dPackedDepth: DefineSpec('boolean'),
};
const DepthMergeShaderCode = ShaderCode('depth-merge', quad_vert, depthMerge_frag);
type DepthMergeRenderable = ComputeRenderable<Values<typeof DepthMergeSchema>>

function getDepthMergeRenderable(ctx: WebGLContext, depthTexturePrimitives: Texture, depthTextureVolumes: Texture, packedDepth: boolean): DepthMergeRenderable {
    const values: Values<typeof DepthMergeSchema> = {
        ...QuadValues,
        tDepthPrimitives: ValueCell.create(depthTexturePrimitives),
        tDepthVolumes: ValueCell.create(depthTextureVolumes),
        uTexSize: ValueCell.create(Vec2.create(depthTexturePrimitives.getWidth(), depthTexturePrimitives.getHeight())),
        dPackedDepth: ValueCell.create(packedDepth),
    };

    const schema = { ...DepthMergeSchema };
    const renderItem = createComputeRenderItem(ctx, 'triangles', DepthMergeShaderCode, schema, values);

    return createComputeRenderable(renderItem, values);
}

const CopyFboSchema = {
    ...QuadSchema,
    tColor: TextureSpec('texture', 'rgba', 'ubyte', 'nearest'),
    tDepth: TextureSpec('texture', 'depth', 'ushort', 'nearest'),
    uTexSize: UniformSpec('v2'),
};
const  CopyFboShaderCode = ShaderCode('copy-fbo', quad_vert, copyFbo_frag);
type  CopyFboRenderable = ComputeRenderable<Values<typeof CopyFboSchema>>

function getCopyFboRenderable(ctx: WebGLContext, colorTexture: Texture, depthTexture: Texture): CopyFboRenderable {
    const values: Values<typeof CopyFboSchema> = {
        ...QuadValues,
        tColor: ValueCell.create(colorTexture),
        tDepth: ValueCell.create(depthTexture),
        uTexSize: ValueCell.create(Vec2.create(colorTexture.getWidth(), colorTexture.getHeight())),
    };

    const schema = { ...CopyFboSchema };
    const renderItem = createComputeRenderItem(ctx, 'triangles', CopyFboShaderCode, schema, values);

    return createComputeRenderable(renderItem, values);
}

export class DrawPass {
    private readonly drawTarget: RenderTarget

    readonly colorTarget: RenderTarget
    readonly depthTexture: Texture
    readonly depthTexturePrimitives: Texture

    readonly packedDepth: boolean

    private depthTarget: RenderTarget
    private depthTargetPrimitives: RenderTarget | null
    private depthTargetVolumes: RenderTarget | null
    private depthTextureVolumes: Texture
    private depthMerge: DepthMergeRenderable

    private copyFboTarget: CopyFboRenderable
    private copyFboPostprocessing: CopyFboRenderable

    private wboit: WboitPass | undefined
    readonly postprocessing: PostprocessingPass
    private readonly fxaa: FxaaPass

    get wboitEnabled() {
        return !!this.wboit?.enabled;
    }

    constructor(private webgl: WebGLContext, width: number, height: number, enableWboit: boolean) {
        const { extensions, resources } = webgl;

        this.drawTarget = createNullRenderTarget(webgl.gl);

        this.colorTarget = webgl.createRenderTarget(width, height, true, 'uint8', 'linear');
        this.packedDepth = !extensions.depthTexture;

        this.depthTarget = webgl.createRenderTarget(width, height);
        this.depthTexture = this.depthTarget.texture;

        this.depthTargetPrimitives = this.packedDepth ? webgl.createRenderTarget(width, height) : null;
        this.depthTargetVolumes = this.packedDepth ? webgl.createRenderTarget(width, height) : null;

        this.depthTexturePrimitives = this.depthTargetPrimitives ? this.depthTargetPrimitives.texture : resources.texture('image-depth', 'depth', 'ushort', 'nearest');
        this.depthTextureVolumes = this.depthTargetVolumes ? this.depthTargetVolumes.texture : resources.texture('image-depth', 'depth', 'ushort', 'nearest');
        if (!this.packedDepth) {
            this.depthTexturePrimitives.define(width, height);
            this.depthTextureVolumes.define(width, height);
        }
        this.depthMerge = getDepthMergeRenderable(webgl, this.depthTexturePrimitives, this.depthTextureVolumes, this.packedDepth);

        this.wboit = enableWboit ? new WboitPass(webgl, width, height) : undefined;
        this.postprocessing = new PostprocessingPass(webgl, this);
        this.fxaa = new FxaaPass(webgl, this);

        this.copyFboTarget = getCopyFboRenderable(webgl, this.colorTarget.texture, this.depthTarget.texture);
        this.copyFboPostprocessing = getCopyFboRenderable(webgl, this.postprocessing.target.texture, this.depthTarget.texture);
    }

    setSize(width: number, height: number) {
        const w = this.colorTarget.getWidth();
        const h = this.colorTarget.getHeight();

        if (width !== w || height !== h) {
            this.colorTarget.setSize(width, height);
            this.depthTarget.setSize(width, height);

            if (this.depthTargetPrimitives) {
                this.depthTargetPrimitives.setSize(width, height);
            } else {
                this.depthTexturePrimitives.define(width, height);
            }

            if (this.depthTargetVolumes) {
                this.depthTargetVolumes.setSize(width, height);
            } else {
                this.depthTextureVolumes.define(width, height);
            }

            ValueCell.update(this.depthMerge.values.uTexSize, Vec2.set(this.depthMerge.values.uTexSize.ref.value, width, height));

            ValueCell.update(this.copyFboTarget.values.uTexSize, Vec2.set(this.copyFboTarget.values.uTexSize.ref.value, width, height));
            ValueCell.update(this.copyFboPostprocessing.values.uTexSize, Vec2.set(this.copyFboPostprocessing.values.uTexSize.ref.value, width, height));

            if (this.wboit?.enabled) {
                this.wboit.setSize(width, height);
            }

            this.postprocessing.setSize(width, height);
            this.fxaa.setSize(width, height);
        }
    }

    private _depthMerge() {
        const { state, gl } = this.webgl;

        this.depthMerge.update();
        this.depthTarget.bind();
        state.disable(gl.BLEND);
        state.disable(gl.DEPTH_TEST);
        state.disable(gl.CULL_FACE);
        state.depthMask(false);
        state.clearColor(1, 1, 1, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.depthMerge.render();
    }

    private _renderWboit(renderer: Renderer, camera: ICamera, scene: Scene, backgroundColor: Color, postprocessingProps: PostprocessingProps) {
        if (!this.wboit?.enabled) throw new Error('expected wboit to be enabled');

        this.colorTarget.bind();
        renderer.clear(true);

        // render opaque primitives
        this.depthTexturePrimitives.attachFramebuffer(this.colorTarget.framebuffer, 'depth');
        this.colorTarget.bind();
        renderer.clearDepth();
        renderer.renderWboitOpaque(scene.primitives, camera, null);

        // render opaque volumes
        this.depthTextureVolumes.attachFramebuffer(this.colorTarget.framebuffer, 'depth');
        this.colorTarget.bind();
        renderer.clearDepth();
        renderer.renderWboitOpaque(scene.volumes, camera, this.depthTexturePrimitives);

        // merge depth of opaque primitives and volumes
        this._depthMerge();

        if (PostprocessingPass.isEnabled(postprocessingProps)) {
            this.postprocessing.render(camera, false, backgroundColor, postprocessingProps);
        }

        // render transparent primitives and volumes
        this.wboit.bind();
        renderer.renderWboitTransparent(scene.primitives, camera, this.depthTexture);
        renderer.renderWboitTransparent(scene.volumes, camera, this.depthTexture);

        // evaluate wboit
        if (PostprocessingPass.isEnabled(postprocessingProps)) {
            this.depthTexturePrimitives.attachFramebuffer(this.postprocessing.target.framebuffer, 'depth');
            this.postprocessing.target.bind();
        } else {
            this.depthTexturePrimitives.attachFramebuffer(this.colorTarget.framebuffer, 'depth');
            this.colorTarget.bind();
        }
        this.wboit.render();
    }

    private _renderBlended(renderer: Renderer, camera: ICamera, scene: Scene, toDrawingBuffer: boolean, postprocessingProps: PostprocessingProps) {
        if (toDrawingBuffer) {
            this.webgl.unbindFramebuffer();
        } else {
            this.colorTarget.bind();
            if (!this.packedDepth) {
                this.depthTexturePrimitives.attachFramebuffer(this.colorTarget.framebuffer, 'depth');
            }
        }

        renderer.clear(true);
        renderer.renderBlendedOpaque(scene.primitives, camera, null);

        // do a depth pass if not rendering to drawing buffer and
        // extensions.depthTexture is unsupported (i.e. depthTarget is set)
        if (!toDrawingBuffer && this.depthTargetPrimitives) {
            this.depthTargetPrimitives.bind();
            renderer.clear(false);
            renderer.renderDepth(scene.primitives, camera, null);
            this.colorTarget.bind();
        }

        // do direct-volume rendering
        if (!toDrawingBuffer) {
            if (!this.packedDepth) {
                this.depthTextureVolumes.attachFramebuffer(this.colorTarget.framebuffer, 'depth');
                renderer.clearDepth(); // from previous frame
            }
            renderer.renderBlendedVolume(scene.volumes, camera, this.depthTexturePrimitives);

            // do volume depth pass if extensions.depthTexture is unsupported (i.e. depthTarget is set)
            if (this.depthTargetVolumes) {
                this.depthTargetVolumes.bind();
                renderer.clear(false);
                renderer.renderDepth(scene.volumes, camera, this.depthTexturePrimitives);
                this.colorTarget.bind();
            }

            if (!this.packedDepth) {
                this.depthTexturePrimitives.attachFramebuffer(this.colorTarget.framebuffer, 'depth');
            }
        }

        renderer.renderBlendedTransparent(scene.primitives, camera, null);

        // merge depths from primitive and volume rendering
        if (!toDrawingBuffer) {
            this._depthMerge();
            this.colorTarget.bind();
        }
    }

    private _render(renderer: Renderer, camera: ICamera, scene: Scene, helper: Helper, toDrawingBuffer: boolean, backgroundColor: Color, postprocessingProps: PostprocessingProps) {
        const antialiasingEnabled = FxaaPass.isEnabled(postprocessingProps);

        const { x, y, width, height } = camera.viewport;
        renderer.setViewport(x, y, width, height);
        renderer.update(camera);

        if (this.wboitEnabled) {
            this._renderWboit(renderer, camera, scene, backgroundColor, postprocessingProps);
        } else {
            this._renderBlended(renderer, camera, scene, !antialiasingEnabled && toDrawingBuffer, postprocessingProps);
        }

        if (PostprocessingPass.isEnabled(postprocessingProps)) {
            this.postprocessing.target.bind();
        } else {
            this.colorTarget.bind();
        }

        if (helper.debug.isEnabled) {
            helper.debug.syncVisibility();
            renderer.renderBlended(helper.debug.scene, camera, null);
        }
        if (helper.handle.isEnabled) {
            renderer.renderBlended(helper.handle.scene, camera, null);
        }
        if (helper.camera.isEnabled) {
            helper.camera.update(camera);
            renderer.update(helper.camera.camera);
            renderer.renderBlended(helper.camera.scene, helper.camera.camera, null);
        }

        if (antialiasingEnabled) {
            this.fxaa.render(camera, toDrawingBuffer, postprocessingProps);
        } else if (toDrawingBuffer) {
            this.drawTarget.bind();

            if (PostprocessingPass.isEnabled(postprocessingProps)) {
                this.copyFboPostprocessing.render();
            } else {
                this.copyFboTarget.render();
            }
        }

        this.webgl.gl.flush();
    }

    render(renderer: Renderer, camera: Camera | StereoCamera, scene: Scene, helper: Helper, toDrawingBuffer: boolean, backgroundColor: Color, transparentBackground: boolean, postprocessingProps: PostprocessingProps) {
        renderer.setTransparentBackground(transparentBackground);
        renderer.setDrawingBufferSize(this.colorTarget.getWidth(), this.colorTarget.getHeight());

        if (StereoCamera.is(camera)) {
            this._render(renderer, camera.left, scene, helper, toDrawingBuffer, backgroundColor, postprocessingProps);
            this._render(renderer, camera.right, scene, helper, toDrawingBuffer, backgroundColor, postprocessingProps);
        } else {
            this._render(renderer, camera, scene, helper, toDrawingBuffer, backgroundColor, postprocessingProps);
        }
    }

    getColorTarget(postprocessingProps: PostprocessingProps): RenderTarget {
        if (FxaaPass.isEnabled(postprocessingProps)) {
            return this.fxaa.target;
        } else if (PostprocessingPass.isEnabled(postprocessingProps)) {
            return this.postprocessing.target;
        }
        return this.colorTarget;
    }
}