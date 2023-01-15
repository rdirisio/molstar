/**
 * Copyright (c) 2018-2022 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Michal Malý <michal.maly@ibt.cas.cz>
 * @author Jiří Černý <jiri.cerny@ibt.cas.cz>
 */

import { NtCTubeTypes as NTT } from './types';
import { NtCTubeProvider } from './property';
import { DnatcoUtil } from '../util';
import { Segmentation, SortedArray } from '../../../mol-data/int';
import { Vec3 } from '../../../mol-math/linear-algebra';
import { ChainIndex, ElementIndex, ResidueIndex, Structure, StructureElement, Unit } from '../../../mol-model/structure';

function getAtomPosition(vec: Vec3, loc: StructureElement.Location, residue: DnatcoUtil.Residue, names: string[], altId: string, insCode: string) {
    const eI = DnatcoUtil.getAtomIndex(loc, residue, names, altId, insCode);
    if (eI !== -1)
        loc.unit.conformation.invariantPosition(eI, vec);
    else {
        vec[0] = 0; vec[1] = 0; vec[2] = 0;
    }
}

const p_1 = Vec3();
const p0 = Vec3();
const p1 = Vec3();
const p2 = Vec3();
const p3 = Vec3();
const p4 = Vec3();
const pP = Vec3();

function getPoints(
    loc: StructureElement.Location,
    r0: DnatcoUtil.Residue | undefined, r1: DnatcoUtil.Residue, r2: DnatcoUtil.Residue,
    altId0: string, altId1: string, altId2: string,
    insCode0: string, insCode1: string, insCode2: string,
) {
    if (r0) getAtomPosition(p_1, loc, r0, ['C5\'', 'C5*'], altId0, insCode0);
    r0 ? getAtomPosition(p0, loc, r0, ['O3\'', 'O3*'], altId0, insCode0) : getAtomPosition(p0, loc, r1, ['O5\'', 'O5*'], altId1, insCode1);
    getAtomPosition(p1, loc, r1, ['C5\'', 'C5*'], altId1, insCode1);
    getAtomPosition(p2, loc, r1, ['O3\'', 'O3*'], altId1, insCode1);
    getAtomPosition(p3, loc, r2, ['C5\'', 'C5*'], altId2, insCode2);
    getAtomPosition(p4, loc, r2, ['O3\'', 'O3*'], altId2, insCode2);
    getAtomPosition(pP, loc, r2, ['P'], altId2, insCode2);

    return { p_1, p0, p1, p2, p3, p4, pP };
}

function hasGapElements(r: DnatcoUtil.Residue, unit: Unit) {
    for (let xI = r.start; xI < r.end; xI++) {
        const eI = unit.elements[xI];
        if (SortedArray.has(unit.gapElements, eI)) {
            return true;
        }
    }

    return false;
}

export type NtCTubeSegment = {
    p_1: Vec3,
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    p4: Vec3,
    pP: Vec3,
    stepIdx: number,
    followsGap: boolean,
    firstInChain: boolean,
    capEnd: boolean,
}

export class NtCTubeSegmentsIterator {
    private chainIt: Segmentation.SegmentIterator<ChainIndex>;
    private residueIt: Segmentation.SegmentIterator<ResidueIndex>;
    private residuePrev?: DnatcoUtil.Residue;
    private residueOne?: DnatcoUtil.Residue;
    private residueTwo: DnatcoUtil.Residue;
    private data?: NTT.Data;
    private altIdOne = '';
    private insCodeOne = '';
    private loc: StructureElement.Location;

    private moveStep() {
        this.residuePrev = DnatcoUtil.copyResidue(this.residueOne);
        this.residueOne = DnatcoUtil.copyResidue(this.residueTwo);
        this.residueTwo = DnatcoUtil.copyResidue(this.residueIt.move())!;

        return this.toSegment(this.residuePrev, this.residueOne!, this.residueTwo);
    }

    private toSegment(r0: DnatcoUtil.Residue | undefined, r1: DnatcoUtil.Residue, r2: DnatcoUtil.Residue): NtCTubeSegment | undefined {
        const indices = DnatcoUtil.getStepIndices(this.data!.data, this.loc, r1);
        if (indices.length === 0)
            return void 0;

        const stepIdx = indices[0];
        const step = this.data!.data.steps[stepIdx];

        const altIdPrev = this.altIdOne;
        const insCodePrev = this.insCodeOne;
        this.altIdOne = step.label_alt_id_1;
        this.insCodeOne = step.PDB_ins_code_1;
        const altIdTwo = step.label_alt_id_2;
        const insCodeTwo = step.PDB_ins_code_2;
        const followsGap = !!r0 && hasGapElements(r0, this.loc.unit) && hasGapElements(r1, this.loc.unit);

        return {
            ...getPoints(this.loc, r0, r1, r2, altIdPrev, this.altIdOne, altIdTwo, insCodePrev, this.insCodeOne, insCodeTwo),
            stepIdx,
            followsGap,
            firstInChain: !r0,
            capEnd: !this.residueIt.hasNext || hasGapElements(r2, this.loc.unit),
        };
    }

    constructor(structure: Structure, unit: Unit.Atomic) {
        this.chainIt = Segmentation.transientSegments(unit.model.atomicHierarchy.chainAtomSegments, unit.elements);
        this.residueIt = Segmentation.transientSegments(unit.model.atomicHierarchy.residueAtomSegments, unit.elements);

        const prop = NtCTubeProvider.get(unit.model).value;
        this.data = prop?.data;

        if (this.chainIt.hasNext) {
            this.residueIt.setSegment(this.chainIt.move());
            if (this.residueIt.hasNext)
                this.residueTwo = this.residueIt.move();
        }

        this.loc = StructureElement.Location.create(structure, unit, -1 as ElementIndex);
    }

    get hasNext() {
        if (!this.data)
            return false;
        return this.residueIt.hasNext
            ? true
            : this.chainIt.hasNext;
    }

    move() {
        if (this.residueIt.hasNext) {
            return this.moveStep();
        } else {
            this.residuePrev = void 0; // Assume discontinuity when we switch chains
            this.residueIt.setSegment(this.chainIt.move());
            if (this.residueIt.hasNext)
                this.residueTwo = this.residueIt.move();
            return this.moveStep();
        }
    }
}
